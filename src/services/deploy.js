// ─────────────────────────────────────────────────────────────────────────────
// deploy.js — Azure Automation runbook edition
//
// Drop-in replacement for the former Azure Functions (Flex) installer. Exports the
// SAME three functions with the SAME signatures the GUI already imports, so no
// component or import line needs to change:
//     detectInstallation(token, subId)            -> installation | null
//     installAutoShutdown(token, subId, config, onLog)
//     uninstallAutoShutdown(token, subId, installation, onLog)
//
// `config` keeps the wizard's existing shape { resourceGroup, functionAppName,
// timezone }. `functionAppName` is reused as the Automation account name so the
// wizard form and the "installed" banner (which reads functionAppName) are
// unchanged. Runbook content is fetched from this app's own origin at /runbooks.
//
// Why runbooks instead of a Flex Function: no storage account, no blob/queue/table
// data plane, no inbound surface, no instrumentation-key telemetry, and no
// scale-to-zero cold-start trigger race. See SECURITY-CROSSWALK.md.
// ─────────────────────────────────────────────────────────────────────────────

const ARM = 'https://management.azure.com'

const MANAGED_TAG_KEY  = 'autoshutdown-managed'
const MANAGED_TAG_VAL  = 'v4-automation'
const MI_PRINCIPAL_TAG = 'autoshutdown-mi-principal-id'

const ROLE_VM_CONTRIBUTOR         = '9980e02c-c2be-4d73-94e8-173b1dc7cf3c'
const ROLE_READER                 = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
const ROLE_AUTOMATION_CONTRIBUTOR = 'f353d9bd-d4a6-484e-a77a-8050b599b867' // self-update

const AA_API   = '2023-11-01'
const MI_API   = '2023-01-31'
const AUTH_API = '2022-04-01'
const RG_API   = '2022-10-01'

// ── shared helpers ───────────────────────────────────────────────────────────

async function armFetch(token, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const text = await res.text()
      try {
        const j = JSON.parse(text)
        msg = j.error?.message ?? j.error?.code ?? j.message ?? msg
        if (j.error?.details?.length) msg += ' — ' + j.error.details.map(d => d.message).join('; ')
      } catch { if (text) msg += ': ' + text.slice(0, 400) }
    } catch {}
    throw new Error(msg)
  }
  const ct = res.headers.get('content-type') ?? ''
  if (res.status === 204 || !ct.includes('json')) return null
  try { return await res.json() } catch { return null }
}

async function poll(fn, { intervalMs = 5000, timeoutMs = 180000, label = 'resource' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await fn()
    if (result) return result
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error(`Timed out waiting for ${label} (after ${Math.round(timeoutMs / 1000)}s).`)
}

async function assignRole(token, subId, scope, principalId, roleDefId) {
  try {
    await armFetch(
      token,
      `${ARM}${scope}/providers/Microsoft.Authorization/roleAssignments/${crypto.randomUUID()}?api-version=${AUTH_API}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          properties: {
            roleDefinitionId: `/subscriptions/${subId}/providers/Microsoft.Authorization/roleDefinitions/${roleDefId}`,
            principalId,
            principalType: 'ServicePrincipal',
          },
        }),
      }
    )
  } catch (e) {
    if (!/RoleAssignmentExists|already exists|409/i.test(e.message)) throw e
  }
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── detectInstallation ─────────────────────────────────────────────────────────
// Drives the "installed" banner and feeds uninstall. Now looks for the Automation
// account (tagged managed) rather than a Function App. Returns the same field
// names the UI expects (functionAppName is reused for the account name).

export async function detectInstallation(token, subId) {
  const data = await armFetch(
    token,
    `${ARM}/providers/Microsoft.ResourceGraph/resources?api-version=${RG_API}`,
    {
      method: 'POST',
      body: JSON.stringify({
        query: `Resources
| where subscriptionId =~ '${subId}'
| where type =~ 'microsoft.automation/automationaccounts'
| where tags['${MANAGED_TAG_KEY}'] =~ '${MANAGED_TAG_VAL}'
| project id, name, resourceGroup, location, tags`,
        subscriptions: [subId],
      }),
    }
  )
  const items = data?.data ?? []
  if (items.length === 0) return null
  const aa = items[0]
  return {
    functionAppId:         aa.id,        // kept for UI compatibility
    functionAppName:       aa.name,      // banner reads this; shows the account name
    automationAccountName: aa.name,
    resourceGroup:         aa.resourceGroup,
    location:              aa.location,
    miPrincipalId:         aa.tags?.[MI_PRINCIPAL_TAG] ?? null,
  }
}

// ── installAutoShutdown ──────────────────────────────────────────────────────

export async function installAutoShutdown(token, subId, config, onLog) {
  const log = (msg, level = 'info') => onLog({ msg, level })

  const {
    resourceGroup,
    functionAppName,                 // reused as the Automation account name
    timezone = 'UTC',
    whatIf = false,
    windowMinutes = 15,
  } = config

  const automationAccountName = functionAppName || 'aa-autoshutdown'
  const miName = 'mi-autoshutdown'
  const managedTags = { [MANAGED_TAG_KEY]: MANAGED_TAG_VAL }

  // Runbook content is served from this app's own origin.
  const runbookBaseUrl =
    (typeof window !== 'undefined' ? window.location.origin : '') + '/runbooks'

  // Resolve the RG location so the account/identity land in the right region.
  log('Reading resource group location...')
  const rg = await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}?api-version=2021-04-01`
  )
  const location = rg?.location
  if (!location) throw new Error(`Could not resolve location for resource group ${resourceGroup}.`)
  log(`Location: ${location}`)

  // ── Step 1: User-Assigned Managed Identity (poll principalId before use) ────
  log('Creating User-Assigned Managed Identity...')
  const miUrl = `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${miName}?api-version=${MI_API}`
  await armFetch(token, miUrl, { method: 'PUT', body: JSON.stringify({ location, tags: managedTags }) })
  const miData = await poll(async () => {
    try {
      const mi = await armFetch(token, miUrl)
      return (mi?.properties?.principalId && mi?.properties?.clientId) ? mi : null
    } catch { return null }
  }, { intervalMs: 5000, timeoutMs: 180000, label: 'managed identity principalId' })
  const miResourceId  = miData.id
  const miClientId    = miData.properties.clientId
  const miPrincipalId = miData.properties.principalId
  if (!miPrincipalId) throw new Error('Managed Identity principalId did not populate; aborting before role assignment.')
  log(`Managed Identity created (principal: ${miPrincipalId})`, 'success')

  // ── Step 2: RBAC ───────────────────────────────────────────────────────────
  log('Assigning Reader role (subscription scope)...')
  await assignRole(token, subId, `/subscriptions/${subId}`, miPrincipalId, ROLE_READER)
  log('Reader role assigned.', 'success')
  log('Assigning Virtual Machine Contributor role (subscription scope)...')
  await assignRole(token, subId, `/subscriptions/${subId}`, miPrincipalId, ROLE_VM_CONTRIBUTOR)
  log('VM Contributor role assigned.', 'success')
  log('Assigning Automation Contributor role (resource group scope, for self-update)...')
  await assignRole(token, subId, `/subscriptions/${subId}/resourceGroups/${resourceGroup}`, miPrincipalId, ROLE_AUTOMATION_CONTRIBUTOR)
  log('Automation Contributor role assigned.', 'success')

  // ── Step 3: Automation Account (UAMI attached, identity verified) ──────────
  log(`Creating Automation Account: ${automationAccountName}...`)
  const aaUrl = `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Automation/automationAccounts/${automationAccountName}?api-version=${AA_API}`
  await armFetch(token, aaUrl, {
    method: 'PUT',
    body: JSON.stringify({
      location,
      tags: { ...managedTags, [MI_PRINCIPAL_TAG]: miPrincipalId },
      identity: { type: 'UserAssigned', userAssignedIdentities: { [miResourceId]: {} } },
      properties: { sku: { name: 'Basic' }, publicNetworkAccess: true },
    }),
  })
  const aa = await poll(async () => {
    try {
      const r = await armFetch(token, aaUrl)
      return r?.properties?.state ? r : null
    } catch { return null }
  }, { intervalMs: 5000, timeoutMs: 120000, label: 'Automation account' })
  const attached = Object.values(aa?.identity?.userAssignedIdentities ?? {})[0]
  if (!attached?.principalId || attached.principalId.toLowerCase() !== miPrincipalId.toLowerCase()) {
    throw new Error(
      `Identity mismatch: roles assigned to ${miPrincipalId}, but the account runs as ${attached?.principalId}. ` +
      `Uninstall, ensure no stale '${miName}' identity/assignments remain, and reinstall.`
    )
  }
  log('Automation Account created and identity verified.', 'success')

  // ── Step 4: Import Az modules ─────────────────────────────────────────────
  // Az.Accounts and Az.Compute are usually preinstalled in the PS 7.2 runtime
  // and are imported best-effort. Az.ResourceGraph is NOT preinstalled and is
  // required — Search-AzGraph will fail at runtime without it. We block until
  // it is confirmed Succeeded before publishing runbooks.
  const modules = [
    { name: 'Az.Accounts',      uri: 'https://www.powershellgallery.com/api/v2/package/Az.Accounts',      required: false },
    { name: 'Az.Compute',       uri: 'https://www.powershellgallery.com/api/v2/package/Az.Compute',       required: false },
    { name: 'Az.ResourceGraph', uri: 'https://www.powershellgallery.com/api/v2/package/Az.ResourceGraph', required: true  },
  ]
  for (const m of modules) {
    log(`Importing module ${m.name}${m.required ? '' : ' (best-effort)'}...`)
    const modUrl = `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Automation/automationAccounts/${automationAccountName}/modules/${m.name}?api-version=${AA_API}`
    try {
      await armFetch(token, modUrl, { method: 'PUT', body: JSON.stringify({ properties: { contentLink: { uri: m.uri } } }) })
      await poll(async () => {
        const r = await armFetch(token, modUrl)
        const s = r?.properties?.provisioningState
        if (s === 'Failed') throw new Error(`Module ${m.name} import Failed.`)
        return s === 'Succeeded' ? r : null
      }, { intervalMs: 10000, timeoutMs: 600000, label: `module ${m.name}` })
      log(`Module ${m.name} ready.`, 'success')
    } catch (e) {
      if (m.required) throw new Error(`Required module ${m.name} failed to import: ${e.message}`)
      log(`Module ${m.name} skipped (runtime likely provides it): ${e.message}`, 'warn')
    }
  }

  // ── Step 5: Create + publish runbooks (content fetched from SWA origin) ────
  const runbooks = [
    { name: 'AutoShutdown', file: 'AutoShutdown.ps1' },
    { name: 'AutoStartup',  file: 'AutoStartup.ps1'  },
  ]
  for (const rb of runbooks) {
    const contentUrl = `${runbookBaseUrl.replace(/\/$/, '')}/${rb.file}`
    log(`Fetching runbook content: ${rb.file}...`)
    const resp = await fetch(contentUrl)
    if (!resp.ok) throw new Error(`Could not fetch runbook content ${contentUrl}: HTTP ${resp.status}`)
    const content = await resp.text()
    const hash = (await sha256Hex(content)).toUpperCase()

    log(`Creating runbook ${rb.name}...`)
    const rbUrl = `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Automation/automationAccounts/${automationAccountName}/runbooks/${rb.name}?api-version=${AA_API}`
    await armFetch(token, rbUrl, {
      method: 'PUT',
      body: JSON.stringify({
        location,
        tags: managedTags,
        properties: {
          runbookType: 'PowerShell72',
          logVerbose: false,
          logProgress: false,
          publishContentLink: { uri: contentUrl, contentHash: { algorithm: 'SHA256', value: hash } },
        },
      }),
    })
    log(`Publishing runbook ${rb.name}...`)
    await armFetch(
      token,
      `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Automation/automationAccounts/${automationAccountName}/runbooks/${rb.name}/publish?api-version=${AA_API}`,
      { method: 'POST' }
    )
    await poll(async () => {
      try {
        const r = await armFetch(token, rbUrl)
        return r?.properties?.state === 'Published' ? r : null
      } catch { return null }
    }, { intervalMs: 5000, timeoutMs: 180000, label: `runbook ${rb.name} publish` })
    log(`Runbook ${rb.name} published.`, 'success')
  }

  // ── Step 6: Schedules + job-schedule links ─────────────────────────────────
  const startTime = new Date(Date.now() + 10 * 60 * 1000).toISOString()
  for (const rb of runbooks) {
    const schedName = `sched-${rb.name}`
    log(`Creating schedule ${schedName} (every ${windowMinutes} min)...`)
    await armFetch(
      token,
      `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Automation/automationAccounts/${automationAccountName}/schedules/${schedName}?api-version=${AA_API}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          name: schedName,
          properties: { startTime, frequency: 'Minute', interval: windowMinutes, timeZone: timezone },
        }),
      }
    )
    log(`Linking ${rb.name} to ${schedName}...`)
    await armFetch(
      token,
      `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Automation/automationAccounts/${automationAccountName}/jobSchedules/${crypto.randomUUID()}?api-version=${AA_API}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          properties: {
            schedule: { name: schedName },
            runbook:  { name: rb.name },
            parameters: {
              WhatIf:        String(whatIf),
              WindowMinutes: String(windowMinutes),
              TimeZoneId:    timezone,
              ClientId:      miClientId,
            },
          },
        }),
      }
    )
    log(`${rb.name} scheduled.`, 'success')
  }

  log('Installation complete!', 'success')
  return { automationAccountName, functionAppName: automationAccountName, resourceGroup, miPrincipalId, miName }
}

// ── uninstallAutoShutdown ──────────────────────────────────────────────────────

export async function uninstallAutoShutdown(token, subId, installation, onLog) {
  const log = (msg, level = 'info') => onLog({ msg, level })
  const resourceGroup = installation.resourceGroup
  const automationAccountName = installation.automationAccountName || installation.functionAppName
  const miName = installation.miName || 'mi-autoshutdown'
  const miPrincipalId = installation.miPrincipalId

  log('Removing RBAC role assignments...')
  const principals = new Set()
  if (miPrincipalId) principals.add(miPrincipalId.toLowerCase())
  try {
    const miList = await armFetch(
      token,
      `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.ManagedIdentity/userAssignedIdentities?api-version=${MI_API}`
    )
    for (const mi of miList?.value ?? []) {
      if (mi?.name === miName && mi?.properties?.principalId) principals.add(mi.properties.principalId.toLowerCase())
    }
  } catch {}
  for (const pid of principals) {
    try {
      const ra = await armFetch(
        token,
        `${ARM}/subscriptions/${subId}/providers/Microsoft.Authorization/roleAssignments?api-version=${AUTH_API}&$filter=principalId eq '${pid}'`
      )
      for (const a of ra?.value ?? []) {
        await armFetch(token, `${ARM}${a.id}?api-version=${AUTH_API}`, { method: 'DELETE' })
        log(`  Removed: ${a.id.split('/').at(-1)}`)
      }
    } catch (e) {
      log(`  Warning: could not fully remove assignments for ${pid}: ${e.message}`, 'warn')
    }
  }
  log('Role assignments removed.', 'success')

  log('Deleting Automation Account...')
  try {
    await armFetch(
      token,
      `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Automation/automationAccounts/${automationAccountName}?api-version=${AA_API}`,
      { method: 'DELETE' }
    )
    log('Automation Account deleted.', 'success')
  } catch (e) { log(`  Warning: ${e.message}`, 'warn') }

  log('Deleting Managed Identity...')
  try {
    await armFetch(
      token,
      `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${miName}?api-version=${MI_API}`,
      { method: 'DELETE' }
    )
    log('Managed Identity deleted.', 'success')
  } catch (e) { log(`  Warning: ${e.message}`, 'warn') }

  log('Uninstall complete.', 'success')
}