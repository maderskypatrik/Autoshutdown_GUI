const ARM = 'https://management.azure.com'

const MANAGED_TAG_KEY = 'autoshutdown-managed'
const MANAGED_TAG_VAL = 'v3'
const MI_PRINCIPAL_TAG = 'autoshutdown-mi-principal-id'

// Role definition IDs (built-in)
const ROLE_VM_CONTRIBUTOR                 = '9980e02c-c2be-4d73-94e8-173b1dc7cf3c'
const ROLE_READER                         = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
const ROLE_WEBSITE_CONTRIBUTOR            = 'de139f84-1756-47ae-9be6-808fbbe84772'
const ROLE_STORAGE_BLOB_DATA_OWNER        = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
const ROLE_STORAGE_QUEUE_DATA_CONTRIBUTOR = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
const ROLE_STORAGE_TABLE_DATA_CONTRIBUTOR = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

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
      const j = await res.json()
      msg = j.error?.message ?? j.message ?? msg
    } catch {}
    throw new Error(msg)
  }
  const contentType = res.headers.get('content-type') ?? ''
  if (res.status === 204 || !contentType.includes('json')) return null
  try { return await res.json() } catch { return null }
}

async function poll(fn, { intervalMs = 5000, timeoutMs = 180000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await fn()
    if (result) return result
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error('Timed out waiting for resource to provision.')
}

// ── Detection ────────────────────────────────────────────────────────────────

export async function detectInstallation(token, subId) {
  const data = await armFetch(
    token,
    `${ARM}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`,
    {
      method: 'POST',
      body: JSON.stringify({
        query: `Resources
| where subscriptionId =~ '${subId}'
| where type =~ 'microsoft.web/sites'
| where tags['${MANAGED_TAG_KEY}'] =~ '${MANAGED_TAG_VAL}'
| project id, name, resourceGroup, location, tags`,
        subscriptions: [subId],
      }),
    }
  )
  const items = data?.data ?? []
  if (items.length === 0) return null
  const fa = items[0]
  return {
    functionAppId:   fa.id,
    functionAppName: fa.name,
    resourceGroup:   fa.resourceGroup,
    location:        fa.location,
    miPrincipalId:   fa.tags?.[MI_PRINCIPAL_TAG] ?? null,
  }
}

// ── Install ──────────────────────────────────────────────────────────────────

export async function installAutoShutdown(token, subId, config, onLog) {
  const { resourceGroup, functionAppName, timezone } = config
  const log = (msg, level = 'info') => onLog({ msg, level })

  const packageUrl = `${window.location.origin}/function-app.zip`

  log('Reading resource group location...')
  const rgData = await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourcegroups/${resourceGroup}?api-version=2021-04-01`
  )
  const location = rgData.location
  log(`Location: ${location}`)

  const rand = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 4).padEnd(4, 'x')
  const storageAccountName = `stautoshutdown${rand}`
  const miName   = 'mi-autoshutdown'
  const planName = 'plan-autoshutdown'
  const managedTags = { [MANAGED_TAG_KEY]: MANAGED_TAG_VAL }

  // ── Step 1: User-Assigned Managed Identity ─────────────────────────────────
  log('Creating User-Assigned Managed Identity...')
  const miData = await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${miName}?api-version=2023-01-31`,
    { method: 'PUT', body: JSON.stringify({ location, tags: managedTags }) }
  )
  const miResourceId  = miData.id
  const miClientId    = miData.properties.clientId
  const miPrincipalId = miData.properties.principalId
  log(`Managed Identity created (principal: ${miPrincipalId})`, 'success')

  // ── Step 2: Storage Account ────────────────────────────────────────────────
  log(`Creating Storage Account: ${storageAccountName}...`)
  await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/${storageAccountName}?api-version=2023-01-01`,
    {
      method: 'PUT',
      body: JSON.stringify({
        kind: 'StorageV2',
        location,
        tags: managedTags,
        sku: { name: 'Standard_LRS' },
        properties: {
          supportsHttpsTrafficOnly: true,
          minimumTlsVersion: 'TLS1_2',
          allowBlobPublicAccess: false,
          keyPolicy: { keyExpirationPeriodInDays: 90 },
        },
      }),
    }
  )
  log('Waiting for Storage Account to provision (up to 3 min)...')
  await poll(async () => {
    const s = await armFetch(
      token,
      `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/${storageAccountName}?api-version=2023-01-01`
    )
    return s?.properties?.provisioningState === 'Succeeded' ? s : null
  })
  log('Storage Account ready.', 'success')
  const keysData = await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/${storageAccountName}/listKeys?api-version=2023-01-01`,
    { method: 'POST' }
  )
  const storageKey = keysData.keys[0].value
  const storageConnectionString = `DefaultEndpointsProtocol=https;AccountName=${storageAccountName};AccountKey=${storageKey};EndpointSuffix=core.windows.net`

  // ── Storage RBAC roles (assigned early so they propagate before Function App starts) ──
  const storageScope = `/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/${storageAccountName}`
  log('Assigning storage identity roles to Managed Identity...')
  await Promise.all([
    assignRole(token, subId, storageScope, miPrincipalId, ROLE_STORAGE_BLOB_DATA_OWNER),
    assignRole(token, subId, storageScope, miPrincipalId, ROLE_STORAGE_QUEUE_DATA_CONTRIBUTOR),
    assignRole(token, subId, storageScope, miPrincipalId, ROLE_STORAGE_TABLE_DATA_CONTRIBUTOR),
  ])
  log('Storage identity roles assigned.', 'success')

  // ── Step 3: App Service Plan (Consumption/Y1) ──────────────────────────────
  log(`Creating App Service Plan: ${planName}...`)
  const planData = await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/serverfarms/${planName}?api-version=2023-01-01`,
    {
      method: 'PUT',
      body: JSON.stringify({
        kind: 'functionapp',
        location,
        tags: managedTags,
        sku: { name: 'Y1', tier: 'Dynamic' },
        properties: { reserved: false },
      }),
    }
  )
  const planId = planData.id
  log('App Service Plan created.', 'success')

  // ── Step 4: Application Insights ──────────────────────────────────────────
  log('Creating Application Insights...')
  const aiName = `ai-${functionAppName}`
  const aiData = await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/microsoft.insights/components/${aiName}?api-version=2020-02-02`,
    {
      method: 'PUT',
      body: JSON.stringify({
        location,
        kind: 'web',
        tags: managedTags,
        properties: { Application_Type: 'web' },
      }),
    }
  )
  const aiConnectionString    = aiData.properties.ConnectionString
  const aiInstrumentationKey  = aiData.properties.InstrumentationKey
  log('Application Insights created.', 'success')

  // ── Step 5: Function App ───────────────────────────────────────────────────
  log(`Creating Function App: ${functionAppName}...`)
  await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${functionAppName}?api-version=2023-01-01`,
    {
      method: 'PUT',
      body: JSON.stringify({
        kind: 'functionapp',
        location,
        tags: {
          ...managedTags,
          [MI_PRINCIPAL_TAG]: miPrincipalId,
        },
        identity: {
          type: 'UserAssigned',
          userAssignedIdentities: { [miResourceId]: {} },
        },
        properties: {
          serverFarmId: planId,
          httpsOnly: true,
          siteConfig: {
            appSettings: [
              { name: 'AzureWebJobsStorage__accountName',                              value: storageAccountName },
              { name: 'AzureWebJobsStorage__credential',                               value: 'managedidentity' },
              { name: 'AzureWebJobsStorage__clientId',                                 value: miClientId },
              { name: 'WEBSITE_CONTENTAZUREFILECONNECTIONSTRING',          value: storageConnectionString },
              { name: 'WEBSITE_CONTENTSHARE',                              value: functionAppName },
              { name: 'FUNCTIONS_EXTENSION_VERSION',             value: '~4' },
              { name: 'FUNCTIONS_WORKER_RUNTIME',                value: 'powershell' },
              { name: 'WEBSITE_RUN_FROM_PACKAGE',                value: packageUrl },
              { name: 'USER_ASSIGNED_MI_CLIENT_ID',              value: miClientId },
              { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING',   value: aiConnectionString },
              { name: 'APPINSIGHTS_INSTRUMENTATIONKEY',          value: aiInstrumentationKey },
              { name: 'WHATIF',                                  value: 'false' },
              { name: 'WINDOW_MINUTES',                          value: '15' },
              { name: 'TIMEZONE',                                value: timezone },
              { name: 'VERSION',                                 value: (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0') },
              { name: 'FUNCTION_APP_RESOURCE_ID',              value: `/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${functionAppName}` },
            ],
            powerShellVersion: '7.4',
            use32BitWorkerProcess: false,
          },
        },
      }),
    }
  )
  log('Function App created.', 'success')

  // ── Step 5: RBAC roles at subscription scope ───────────────────────────────
  log('Assigning Virtual Machine Contributor role...')
  await assignRole(token, subId, `/subscriptions/${subId}`, miPrincipalId, ROLE_VM_CONTRIBUTOR)
  log('VM Contributor role assigned.', 'success')

  log('Assigning Reader role...')
  await assignRole(token, subId, `/subscriptions/${subId}`, miPrincipalId, ROLE_READER)
  log('Reader role assigned.', 'success')

  log('Assigning Website Contributor role on resource group (for self-update)...')
  await assignRole(token, subId, `/subscriptions/${subId}/resourceGroups/${resourceGroup}`, miPrincipalId, ROLE_WEBSITE_CONTRIBUTOR)
  log('Website Contributor role assigned.', 'success')

  // ── Storage network hardening (applied after Function App is provisioned) ────
  log('Applying storage account network restrictions...')
  await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/${storageAccountName}?api-version=2023-01-01`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        properties: {
          networkAcls: { defaultAction: 'Deny', bypass: 'AzureServices,Logging,Metrics' },
        },
      }),
    }
  )
  log('Storage account network restrictions applied.', 'success')

  log('Installation complete!', 'success')
  return { functionAppName, resourceGroup, location }
}

async function assignRole(token, subId, scope, principalId, roleDefId) {
  await armFetch(
    token,
    `${ARM}${scope}/providers/Microsoft.Authorization/roleAssignments/${crypto.randomUUID()}?api-version=2022-04-01`,
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
}

// ── Uninstall ────────────────────────────────────────────────────────────────

export async function uninstallAutoShutdown(token, subId, installation, onLog) {
  const log = (msg, level = 'info') => onLog({ msg, level })
  const { miPrincipalId } = installation

  log('Finding AutoShutdown resources...')
  const data = await armFetch(
    token,
    `${ARM}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`,
    {
      method: 'POST',
      body: JSON.stringify({
        query: `Resources
| where subscriptionId =~ '${subId}'
| where tags['${MANAGED_TAG_KEY}'] =~ '${MANAGED_TAG_VAL}'
| project id, name, type, resourceGroup`,
        subscriptions: [subId],
      }),
    }
  )
  const resources = data?.data ?? []
  log(`Found ${resources.length} resource(s) to remove.`)

  if (miPrincipalId) {
    log('Removing RBAC role assignments...')
    try {
      const raData = await armFetch(
        token,
        `${ARM}/subscriptions/${subId}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=principalId eq '${miPrincipalId}'`
      )
      for (const ra of raData?.value ?? []) {
        await armFetch(token, `${ARM}${ra.id}?api-version=2022-04-01`, { method: 'DELETE' })
        log(`  Removed: ${ra.id.split('/').at(-1)}`)
      }
    } catch (e) {
      log(`  Warning: could not fully remove role assignments: ${e.message}`, 'warn')
    }
    log('Role assignments removed.', 'success')
  }

  // Delete resources in dependency order
  const typeOrder = [
    'microsoft.web/sites',
    'microsoft.web/serverfarms',
    'microsoft.storage/storageaccounts',
    'microsoft.managedidentity/userassignedidentities',
  ]
  const sorted = [...resources].sort((a, b) => {
    const ai = typeOrder.indexOf(a.type.toLowerCase())
    const bi = typeOrder.indexOf(b.type.toLowerCase())
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
  })

  for (const res of sorted) {
    const label = `${res.type.split('/').at(-1)}: ${res.name}`
    log(`Deleting ${label}...`)
    try {
      await armFetch(token, `${ARM}${res.id}?api-version=${apiVersionFor(res.type)}`, { method: 'DELETE' })
      log(`  Deleted: ${res.name}`, 'success')
    } catch (e) {
      log(`  Warning: ${e.message}`, 'warn')
    }
  }

  log('Uninstallation complete. All AutoShutdown resources have been removed.', 'success')
}

function apiVersionFor(type) {
  const t = type.toLowerCase()
  if (t.includes('managedidentity')) return '2023-01-31'
  if (t.includes('insights'))        return '2020-02-02'
  return '2023-01-01'
}
