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

import autoShutdownContent from '../../public/runbooks/AutoShutdown.ps1?raw'
import autoStartupContent  from '../../public/runbooks/AutoStartup.ps1?raw'

const ARM = 'https://management.azure.com'

const MANAGED_TAG_KEY     = 'autoshutdown-managed'
const MANAGED_TAG_VAL     = 'v4-automation'
const MI_PRINCIPAL_TAG    = 'autoshutdown-mi-principal-id'
const MANAGED_TAG_VERSION = 'autoshutdown-version'

export const RUNBOOK_VERSION = '20260701'

const ROLE_VM_CONTRIBUTOR         = '9980e02c-c2be-4d73-94e8-173b1dc7cf3c'
const ROLE_READER                 = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
const ROLE_AUTOMATION_CONTRIBUTOR = 'f353d9bd-d4a6-484e-a77a-8050b599b867'

const AA_API     = '2023-11-01'
const AUTH_API   = '2022-04-01'
const RG_API     = '2022-10-01'
const MONITOR_API = '2023-01-01'
const METRIC_API  = '2018-03-01'

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

// ── alert helpers ────────────────────────────────────────────────────────────────

async function createAlertResources(token, subId, rg, location, aaResourceId, aaName, emails, subscriptionName = '') {
  const agName    = `ag-${aaName}`
  const alertName = `alert-${aaName}-failed`

  await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${rg}/providers/microsoft.insights/actionGroups/${agName}?api-version=${MONITOR_API}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        location: 'Global',
        properties: {
          groupShortName: 'autoshutdown',
          enabled: true,
          emailReceivers: emails.map((email, i) => ({
            name: `recipient-${i}`,
            emailAddress: email,
            useCommonAlertSchema: true,
          })),
        },
      }),
    }
  )

  const agResourceId = `/subscriptions/${subId}/resourceGroups/${rg}/providers/microsoft.insights/actionGroups/${agName}`

  await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${rg}/providers/microsoft.insights/metricAlerts/${alertName}?api-version=${METRIC_API}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        location: 'global',
        properties: {
          description: `A runbook job failed in the AutoShutdown solution.\n\nSubscription: ${subscriptionName || subId}\nAutomation Account: ${aaName}\nResource Group: ${rg}\n\nTo investigate, open the Azure Portal and go to:\nAutomation Accounts → ${aaName} → Jobs\n\nLook for the most recent Failed job and check its output for the error details.`,
          severity: 2,
          enabled: true,
          scopes: [aaResourceId],
          evaluationFrequency: 'PT15M',
          windowSize: 'PT15M',
          criteria: {
            'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria',
            allOf: [{
              name: 'FailedJobs',
              metricName: 'TotalJob',
              dimensions: [{ name: 'Status', operator: 'Include', values: ['Failed'] }],
              operator: 'GreaterThan',
              threshold: 0,
              timeAggregation: 'Total',
              criterionType: 'StaticThresholdCriterion',
            }],
          },
          actions: [{ actionGroupId: agResourceId }],
        },
      }),
    }
  )
}

async function deleteAlertResources(token, subId, rg, aaName) {
  const resources = [
    { type: 'microsoft.insights/actionGroups', name: `ag-${aaName}`,           api: MONITOR_API },
    { type: 'microsoft.insights/metricAlerts', name: `alert-${aaName}-failed`, api: METRIC_API  },
  ]
  for (const r of resources) {
    try {
      await armFetch(
        token,
        `${ARM}/subscriptions/${subId}/resourceGroups/${rg}/providers/${r.type}/${r.name}?api-version=${r.api}`,
        { method: 'DELETE' }
      )
    } catch (e) {
      if (!/404|NotFound|ResourceNotFound/i.test(e.message)) throw e
    }
  }
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
| project id, name, resourceGroup, location, tags, identity`,
        subscriptions: [subId],
      }),
    }
  )
  const items = data?.data ?? []
  if (items.length === 0) return null
  const aa = items[0]

  let notificationEmails = []
  try {
    const ag = await armFetch(
      token,
      `${ARM}/subscriptions/${subId}/resourceGroups/${aa.resourceGroup}/providers/microsoft.insights/actionGroups/ag-${aa.name}?api-version=${MONITOR_API}`
    )
    notificationEmails = (ag?.properties?.emailReceivers ?? []).map(r => r.emailAddress)
  } catch {}

  return {
    functionAppId:         aa.id,
    functionAppName:       aa.name,
    automationAccountName: aa.name,
    resourceGroup:         aa.resourceGroup,
    location:              aa.location,
    miPrincipalId:         aa.identity?.principalId ?? aa.tags?.[MI_PRINCIPAL_TAG] ?? null,
    version:               aa.tags?.[MANAGED_TAG_VERSION] ?? null,
    notificationEmails,
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
    subscriptionName = subId,
    installedBy = '',
    notificationEmails = [],
  } = config

  const automationAccountName = functionAppName || 'aa-autoshutdown'
  const managedTags = { [MANAGED_TAG_KEY]: MANAGED_TAG_VAL, [MANAGED_TAG_VERSION]: RUNBOOK_VERSION }

  // Resolve the RG location so the account lands in the right region.
  log('Reading resource group location...')
  const rg = await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}?api-version=2021-04-01`
  )
  const location = rg?.location
  if (!location) throw new Error(`Could not resolve location for resource group ${resourceGroup}.`)
  log(`Location: ${location}`)

  // ── Step 1: Automation Account with system-assigned managed identity ────────
  log(`Creating Automation Account: ${automationAccountName}...`)
  const aaUrl = `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Automation/automationAccounts/${automationAccountName}?api-version=${AA_API}`
  await armFetch(token, aaUrl, {
    method: 'PUT',
    body: JSON.stringify({
      location,
      tags: managedTags,
      identity: { type: 'SystemAssigned' },
      properties: { sku: { name: 'Basic' }, publicNetworkAccess: true },
    }),
  })
  const aa = await poll(async () => {
    try {
      const r = await armFetch(token, aaUrl)
      return r?.identity?.principalId ? r : null
    } catch { return null }
  }, { intervalMs: 5000, timeoutMs: 120000, label: 'Automation account system-assigned identity' })
  const miPrincipalId = aa.identity.principalId
  log(`Automation Account created (principal: ${miPrincipalId}).`, 'success')

  // ── Step 2: RBAC ───────────────────────────────────────────────────────────
  log('Assigning Reader role (subscription scope)...')
  await assignRole(token, subId, `/subscriptions/${subId}`, miPrincipalId, ROLE_READER)
  log('Reader role assigned.', 'success')
  log('Assigning Virtual Machine Contributor role (subscription scope)...')
  await assignRole(token, subId, `/subscriptions/${subId}`, miPrincipalId, ROLE_VM_CONTRIBUTOR)
  log('VM Contributor role assigned.', 'success')
  log('Assigning Automation Contributor role (resource group scope)...')
  await assignRole(token, subId, `/subscriptions/${subId}/resourceGroups/${resourceGroup}`, miPrincipalId, ROLE_AUTOMATION_CONTRIBUTOR)
  log('Automation Contributor role assigned.', 'success')

  // ── Step 3: Create + publish runbooks (content bundled at build time) ────────
  const runbooks = [
    { name: 'AutoShutdown', content: autoShutdownContent },
    { name: 'AutoStartup',  content: autoStartupContent  },
  ]
  for (const rb of runbooks) {
    log(`Creating runbook ${rb.name}...`)
    const rbUrl = `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Automation/automationAccounts/${automationAccountName}/runbooks/${rb.name}?api-version=${AA_API}`
    await armFetch(token, rbUrl, {
      method: 'PUT',
      body: JSON.stringify({
        location,
        tags: managedTags,
        properties: { runbookType: 'PowerShell72', logVerbose: false, logProgress: false },
      }),
    })
    log(`Uploading runbook content: ${rb.name}...`)
    await fetch(
      `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Automation/automationAccounts/${automationAccountName}/runbooks/${rb.name}/draft/content?api-version=${AA_API}`,
      { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/powershell' }, body: rb.content }
    )
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

  // ── Step 4: Schedules + job-schedule links ─────────────────────────────────
  // Snap to the next windowMinutes clock boundary (e.g. :00/:15/:30/:45 for 15 min).
  // Azure Automation requires startTime >= 5 min in the future at schedule creation time.
  // 6-minute buffer gives enough margin even when install takes 1-2 min to reach this step.
  const interval  = windowMinutes * 60 * 1000
  const startTime = new Date(Math.ceil((Date.now() + 6 * 60_000) / interval) * interval).toISOString()
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
            },
          },
        }),
      }
    )
    log(`${rb.name} scheduled.`, 'success')
  }

  if (notificationEmails.length > 0) {
    log(`Setting up failure notifications for ${notificationEmails.length} recipient(s)...`)
    try {
      await createAlertResources(token, subId, resourceGroup, location, aa.id, automationAccountName, notificationEmails, subscriptionName)
      log(`Failure alerts configured (${notificationEmails.join(', ')}).`, 'success')
    } catch (e) {
      log(`Warning: could not create alert resources: ${e.message}`, 'warn')
    }
  }

  log('Installation complete!', 'success')

  try {
    await fetch('/api/confluence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', subscriptionId: subId, subscriptionName, automationAccountName, installedBy }),
    })
  } catch {}

  return { automationAccountName, functionAppName: automationAccountName, resourceGroup, miPrincipalId }
}

// ── updateRunbooks ─────────────────────────────────────────────────────────────
// Re-publishes runbooks from the current SWA origin and stamps the new version
// tag on the Automation Account. Does not touch RBAC, schedules, or the account
// itself — safe to run against a live installation.

export async function updateRunbooks(token, subId, installation, onLog) {
  const log = (msg, level = 'info') => onLog({ msg, level })
  const { resourceGroup, automationAccountName, location } = installation

  const runbooks = [
    { name: 'AutoShutdown', content: autoShutdownContent },
    { name: 'AutoStartup',  content: autoStartupContent  },
  ]

  for (const rb of runbooks) {
    log(`Updating runbook ${rb.name}...`)
    const rbUrl = `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Automation/automationAccounts/${automationAccountName}/runbooks/${rb.name}?api-version=${AA_API}`
    await armFetch(token, rbUrl, {
      method: 'PUT',
      body: JSON.stringify({
        location,
        tags: { [MANAGED_TAG_KEY]: MANAGED_TAG_VAL, [MANAGED_TAG_VERSION]: RUNBOOK_VERSION },
        properties: { runbookType: 'PowerShell72', logVerbose: false, logProgress: false },
      }),
    })
    log(`Uploading runbook content: ${rb.name}...`)
    await fetch(
      `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Automation/automationAccounts/${automationAccountName}/runbooks/${rb.name}/draft/content?api-version=${AA_API}`,
      { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/powershell' }, body: rb.content }
    )
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
    log(`Runbook ${rb.name} updated.`, 'success')
  }

  log('Stamping new version on Automation Account...')
  await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Automation/automationAccounts/${automationAccountName}?api-version=${AA_API}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        tags: { [MANAGED_TAG_KEY]: MANAGED_TAG_VAL, [MANAGED_TAG_VERSION]: RUNBOOK_VERSION },
      }),
    }
  )
  log('Update complete!', 'success')
}

// ── updateAlertEmails ──────────────────────────────────────────────────────────

export async function updateAlertEmails(token, subId, installation, emails) {
  const { resourceGroup, automationAccountName, functionAppId, location, subscriptionName } = installation
  if (emails.length === 0) {
    await deleteAlertResources(token, subId, resourceGroup, automationAccountName)
  } else {
    await createAlertResources(token, subId, resourceGroup, location, functionAppId, automationAccountName, emails, subscriptionName)
  }
}

// ── uninstallAutoShutdown ──────────────────────────────────────────────────────

export async function uninstallAutoShutdown(token, subId, installation, onLog) {
  const log = (msg, level = 'info') => onLog({ msg, level })
  const resourceGroup = installation.resourceGroup
  const automationAccountName = installation.automationAccountName || installation.functionAppName
  const miPrincipalId = installation.miPrincipalId

  log('Removing RBAC role assignments...')
  if (miPrincipalId) {
    try {
      const ra = await armFetch(
        token,
        `${ARM}/subscriptions/${subId}/providers/Microsoft.Authorization/roleAssignments?api-version=${AUTH_API}&$filter=principalId eq '${miPrincipalId}'`
      )
      for (const a of ra?.value ?? []) {
        await armFetch(token, `${ARM}${a.id}?api-version=${AUTH_API}`, { method: 'DELETE' })
        log(`  Removed: ${a.id.split('/').at(-1)}`)
      }
    } catch (e) {
      log(`  Warning: could not fully remove assignments for ${miPrincipalId}: ${e.message}`, 'warn')
    }
  }
  log('Role assignments removed.', 'success')

  log('Removing failure alert and action group (if configured)...')
  try {
    await deleteAlertResources(token, subId, resourceGroup, automationAccountName)
    log('Alert resources removed.', 'success')
  } catch (e) {
    log(`Warning: could not remove alert resources: ${e.message}`, 'warn')
  }

  log('Deleting Automation Account (system-assigned identity deleted automatically)...')
  try {
    await armFetch(
      token,
      `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Automation/automationAccounts/${automationAccountName}?api-version=${AA_API}`,
      { method: 'DELETE' }
    )
    log('Automation Account deleted.', 'success')
  } catch (e) { log(`  Warning: ${e.message}`, 'warn') }

  log('Uninstall complete.', 'success')

  try {
    await fetch('/api/confluence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove', subscriptionId: subId }),
    })
  } catch {}
}