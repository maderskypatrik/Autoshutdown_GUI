const ARM = 'https://management.azure.com'

const MANAGED_TAG_KEY = 'autoshutdown-managed'
const MANAGED_TAG_VAL = 'v3'
const MI_PRINCIPAL_TAG = 'autoshutdown-mi-principal-id'

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
      const text = await res.text()
      try {
        const j = JSON.parse(text)
        msg = j.error?.message ?? j.error?.code ?? j.message ?? msg
        if (j.error?.details?.length) msg += ' — ' + j.error.details.map(d => d.message).join('; ')
      } catch {
        if (text) msg += ': ' + text.slice(0, 400)
      }
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

async function uploadBlobBlocks(accountName, containerName, blobName, arrayBuffer, sasToken) {
  const base = `https://${accountName}.blob.core.windows.net/${containerName}/${blobName}`
  const chunkSize = 25 * 1024 * 1024
  const blockIds = []

  for (let offset = 0; offset < arrayBuffer.byteLength; offset += chunkSize) {
    const chunk = arrayBuffer.slice(offset, Math.min(offset + chunkSize, arrayBuffer.byteLength))
    const blockId = btoa(String(blockIds.length).padStart(6, '0'))
    blockIds.push(blockId)
    const res = await fetch(`${base}?comp=block&blockid=${encodeURIComponent(blockId)}&${sasToken}`, {
      method: 'PUT',
      headers: { 'x-ms-version': '2020-10-02' },
      body: chunk,
    })
    if (!res.ok) throw new Error(`Block upload failed: HTTP ${res.status}`)
  }

  const xml = `<?xml version="1.0" encoding="utf-8"?><BlockList>${blockIds.map(id => `<Latest>${id}</Latest>`).join('')}</BlockList>`
  const res = await fetch(`${base}?comp=blocklist&${sasToken}`, {
    method: 'PUT',
    headers: {
      'x-ms-version': '2020-10-02',
      'Content-Type': 'application/xml',
      'x-ms-blob-content-type': 'application/zip',
    },
    body: xml,
  })
  if (!res.ok) throw new Error(`Commit block list failed: HTTP ${res.status}`)
}

// ── Detection ─────────────────────────────────────────────────────────────────

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

// ── Install ───────────────────────────────────────────────────────────────────

export async function installAutoShutdown(token, subId, config, onLog) {
  const { resourceGroup, functionAppName, timezone } = config
  const log = (msg, level = 'info') => onLog({ msg, level })

  log('Reading resource group location...')
  const rgData = await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourcegroups/${resourceGroup}?api-version=2021-04-01`
  )
  const location = rgData.location
  log(`Location: ${location}`)

  const rand = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 4).padEnd(4, 'x')
  const storageAccountName = `stautoshutdown${rand}`
  const miName      = 'mi-autoshutdown'
  const planName    = 'plan-autoshutdown'
  const vnetName    = 'vnet-autoshutdown'
  const nsgName     = 'nsg-autoshutdown'
  const peName      = 'pe-autoshutdown-blob'
  const dnsZoneName = 'privatelink.blob.core.windows.net'
  const managedTags = { [MANAGED_TAG_KEY]: MANAGED_TAG_VAL }

  // ── Step 1: Managed Identity ───────────────────────────────────────────────
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

  // ── Step 2: NSG ───────────────────────────────────────────────────────────
  log('Creating Network Security Group (nsg-01)...')
  const nsgData = await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/networkSecurityGroups/${nsgName}?api-version=2023-09-01`,
    {
      method: 'PUT',
      body: JSON.stringify({
        location,
        tags: managedTags,
        properties: {
          securityRules: [
            {
              name: 'DenyHighRiskInbound',
              properties: {
                priority: 100,
                protocol: '*',
                sourcePortRange: '*',
                destinationPortRanges: ['22', '3389', '1433', '3306', '5432', '23', '21', '445', '135'],
                sourceAddressPrefix: 'Internet',
                destinationAddressPrefix: '*',
                access: 'Deny',
                direction: 'Inbound',
              },
            },
          ],
        },
      }),
    }
  )
  const nsgId = nsgData.id
  log('NSG created.', 'success')

  // ── Step 3: VNet (flex subnet + PE subnet) ────────────────────────────────
  log('Creating Virtual Network...')
  const vnetData = await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/virtualNetworks/${vnetName}?api-version=2023-09-01`,
    {
      method: 'PUT',
      body: JSON.stringify({
        location,
        tags: managedTags,
        properties: {
          addressSpace: { addressPrefixes: ['10.200.0.0/16'] },
          subnets: [
            {
              name: 'snet-flex',
              properties: {
                addressPrefix: '10.200.1.0/24',
                networkSecurityGroup: { id: nsgId },
                serviceEndpoints: [{ service: 'Microsoft.Storage' }],
              },
            },
            {
              name: 'snet-pe',
              properties: {
                addressPrefix: '10.200.2.0/24',
                networkSecurityGroup: { id: nsgId },
                privateEndpointNetworkPolicies: 'Disabled',
              },
            },
          ],
        },
      }),
    }
  )
  if (!vnetData?.id) throw new Error('VNet creation did not return a resource ID — ARM may have returned 202 without body.')
  const vnetId       = vnetData.id
  const flexSubnetId = vnetData.properties.subnets.find(s => s.name === 'snet-flex')?.id
  const peSubnetId   = vnetData.properties.subnets.find(s => s.name === 'snet-pe')?.id
  if (!flexSubnetId || !peSubnetId) throw new Error(`Subnet IDs missing from VNet response (flex=${flexSubnetId}, pe=${peSubnetId})`)
  log('Virtual Network created.', 'success')

  // ── Step 4: Storage Account (open, hardened after deploy) ─────────────────
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
  const storageData = await poll(async () => {
    const s = await armFetch(
      token,
      `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/${storageAccountName}?api-version=2023-01-01`
    )
    return s?.properties?.provisioningState === 'Succeeded' ? s : null
  })
  const storageAccountId = storageData.id
  log('Storage Account ready.', 'success')

  // ── Step 5: Blob container for deployment package ─────────────────────────
  log('Creating deployment blob container...')
  await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/${storageAccountName}/blobServices/default/containers/deployment?api-version=2023-01-01`,
    { method: 'PUT', body: JSON.stringify({ properties: { publicAccess: 'None' } }) }
  )
  log('Blob container created.', 'success')

  // ── Step 5b: CORS on blob service (required for browser upload) ──────────
  log('Configuring blob service CORS...')
  await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/${storageAccountName}/blobServices/default?api-version=2023-01-01`,
    {
      method: 'PUT',
      body: JSON.stringify({
        properties: {
          cors: {
            corsRules: [
              {
                allowedOrigins: ['*'],
                allowedMethods: ['GET', 'HEAD', 'PUT', 'OPTIONS'],
                allowedHeaders: ['*'],
                exposedHeaders: [],
                maxAgeInSeconds: 3600,
              },
            ],
          },
        },
      }),
    }
  )
  log('CORS configured.', 'success')

  // ── Step 5c: Wait for CORS to go live on the blob data plane ─────────────
  // ARM returns 200 but the storage data plane picks up CORS asynchronously.
  // A simple HEAD (no custom headers → no preflight) throws TypeError when
  // CORS isn't ready yet, and resolves (any status) once CORS headers appear.
  log('Waiting for blob CORS to propagate (up to 2 min)...')
  const corsProbeUrl = `https://${storageAccountName}.blob.core.windows.net/deployment?restype=container`
  let corsReady = false
  for (let i = 0; i < 24 && !corsReady; i++) {
    await new Promise(r => setTimeout(r, 5000))
    try { await fetch(corsProbeUrl, { method: 'HEAD' }); corsReady = true } catch {}
  }
  if (!corsReady) throw new Error('Storage CORS did not become available within 2 minutes.')
  log('Blob CORS is live.', 'success')

  // ── Step 6: Storage RBAC roles ────────────────────────────────────────────
  const storageScope = `/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/${storageAccountName}`
  log('Assigning storage RBAC roles to Managed Identity...')
  await Promise.all([
    assignRole(token, subId, storageScope, miPrincipalId, ROLE_STORAGE_BLOB_DATA_OWNER),
    assignRole(token, subId, storageScope, miPrincipalId, ROLE_STORAGE_QUEUE_DATA_CONTRIBUTOR),
    assignRole(token, subId, storageScope, miPrincipalId, ROLE_STORAGE_TABLE_DATA_CONTRIBUTOR),
  ])
  log('Storage RBAC roles assigned.', 'success')

  // ── Step 7: Upload deployment package via ARM-generated SAS ──────────────
  log('Generating SAS token for package upload...')
  const sasExpiry = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 19) + 'Z'
  const sasData = await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/${storageAccountName}/listAccountSas?api-version=2023-01-01`,
    {
      method: 'POST',
      body: JSON.stringify({
        signedServices: 'b',
        signedResourceTypes: 'o',
        signedPermission: 'rw',
        signedProtocol: 'https',
        signedExpiry: sasExpiry,
      }),
    }
  )
  const sasToken = sasData.accountSasToken
  log('Downloading function package...')
  const pkgRes = await fetch(`${window.location.origin}/function-app.zip`)
  if (!pkgRes.ok) throw new Error(`Failed to fetch function-app.zip: HTTP ${pkgRes.status}`)
  const pkgBuffer = await pkgRes.arrayBuffer()
  log(`Package downloaded (${Math.round(pkgBuffer.byteLength / 1024 / 1024)} MB). Uploading to storage...`)
  await uploadBlobBlocks(storageAccountName, 'deployment', 'function-app.zip', pkgBuffer, sasToken)
  log('Package uploaded to blob storage.', 'success')

  // ── Step 8: Flex Consumption Plan ─────────────────────────────────────────
  log(`Creating Flex Consumption Plan: ${planName}...`)
  await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/serverfarms/${planName}?api-version=2024-04-01`,
    {
      method: 'PUT',
      body: JSON.stringify({
        kind: 'functionapp',
        location,
        tags: managedTags,
        sku: { name: 'FC1', tier: 'FlexConsumption' },
        properties: { reserved: true },
      }),
    }
  )
  log('Waiting for Flex Consumption Plan to be ready...')
  const planFinal = await poll(async () => {
    const p = await armFetch(
      token,
      `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/serverfarms/${planName}?api-version=2024-04-01`
    )
    return p?.properties?.status === 'Ready' ? p : null
  })
  const planId = planFinal.id
  log('Flex Consumption Plan created.', 'success')

  // ── Step 9: Application Insights ─────────────────────────────────────────
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
  const aiConnectionString   = aiData.properties.ConnectionString
  const aiInstrumentationKey = aiData.properties.InstrumentationKey
  log('Application Insights created.', 'success')

  // ── Step 10: Function App (Flex Consumption, VNet integrated) ─────────────
  if (!planId)        throw new Error('planId is null — plan did not return an ARM resource ID')
  if (!flexSubnetId)  throw new Error('flexSubnetId is null — VNet response missing snet-flex ID')
  if (!miResourceId)  throw new Error('miResourceId is null — MI response missing resource ID')
  log(`Creating Function App: ${functionAppName}...`)
  await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${functionAppName}?api-version=2024-04-01`,
    {
      method: 'PUT',
      body: JSON.stringify({
        kind: 'functionapp,linux',
        location,
        tags: { ...managedTags, [MI_PRINCIPAL_TAG]: miPrincipalId },
        identity: {
          type: 'UserAssigned',
          userAssignedIdentities: { [miResourceId]: {} },
        },
        properties: {
          serverFarmId: planId,
          httpsOnly: true,
          functionAppConfig: {
            deployment: {
              storage: {
                type: 'blobContainer',
                value: `https://${storageAccountName}.blob.core.windows.net/deployment`,
                authentication: {
                  type: 'UserAssignedIdentity',
                  userAssignedIdentityResourceId: miResourceId,
                },
              },
            },
            scaleAndConcurrency: {
              instanceMemoryMB: 2048,
              maximumInstanceCount: 100,
            },
            runtime: {
              name: 'powershell',
              version: '7.4',
            },
          },
          siteConfig: {
            appSettings: [
              { name: 'AzureWebJobsStorage__accountName',          value: storageAccountName },
              { name: 'AzureWebJobsStorage__credential',           value: 'managedidentity' },
              { name: 'AzureWebJobsStorage__clientId',             value: miClientId },
              { name: 'USER_ASSIGNED_MI_CLIENT_ID',                value: miClientId },
              { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING',     value: aiConnectionString },
              { name: 'APPINSIGHTS_INSTRUMENTATIONKEY',            value: aiInstrumentationKey },
              { name: 'WHATIF',                                    value: 'false' },
              { name: 'WINDOW_MINUTES',                            value: '15' },
              { name: 'TIMEZONE',                                  value: timezone },
              { name: 'VERSION',                                   value: (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0') },
              { name: 'FUNCTION_APP_RESOURCE_ID',                  value: `/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${functionAppName}` },
              { name: 'WEBSITE_DNS_SERVER',                        value: '168.63.129.16' },
            ],
          },
        },
      }),
    }
  )
  log('Function App created.', 'success')

  // ── Step 10b: Attach Swift VNet integration via virtualNetworkConnections ──
  // This is the endpoint Azure CLI (az functionapp vnet-integration add) uses.
  // networkConfig/virtualNetwork and site PATCH both return empty 400 for FC1.
  log('Enabling VNet integration on Function App...')
  const vnetShortName = vnetId.split('/').pop()
  await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${functionAppName}/virtualNetworkConnections/${vnetShortName}?api-version=2022-03-01`,
    {
      method: 'PUT',
      body: JSON.stringify({
        properties: {
          subnetResourceId: flexSubnetId,
          isSwift: true,
        },
      }),
    }
  )
  log('VNet integration enabled.', 'success')

  // ── Step 11: Subscription + RG RBAC ──────────────────────────────────────
  log('Assigning Virtual Machine Contributor role...')
  await assignRole(token, subId, `/subscriptions/${subId}`, miPrincipalId, ROLE_VM_CONTRIBUTOR)
  log('VM Contributor role assigned.', 'success')

  log('Assigning Reader role...')
  await assignRole(token, subId, `/subscriptions/${subId}`, miPrincipalId, ROLE_READER)
  log('Reader role assigned.', 'success')

  log('Assigning Website Contributor role on resource group (for self-update)...')
  await assignRole(token, subId, `/subscriptions/${subId}/resourceGroups/${resourceGroup}`, miPrincipalId, ROLE_WEBSITE_CONTRIBUTOR)
  log('Website Contributor role assigned.', 'success')

  // ── Step 12: Private endpoint for blob (sa-04) ────────────────────────────
  log('Creating private endpoint for blob storage (sa-04)...')
  const peData = await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/privateEndpoints/${peName}?api-version=2023-09-01`,
    {
      method: 'PUT',
      body: JSON.stringify({
        location,
        tags: managedTags,
        properties: {
          subnet: { id: peSubnetId },
          privateLinkServiceConnections: [
            {
              name: 'plsc-blob',
              properties: {
                privateLinkServiceId: storageAccountId,
                groupIds: ['blob'],
              },
            },
          ],
        },
      }),
    }
  )
  const peId = peData.id
  log('Waiting for private endpoint to provision...')
  await poll(async () => {
    try {
      const pe = await armFetch(token, `${ARM}${peId}?api-version=2023-09-01`)
      return pe?.properties?.provisioningState === 'Succeeded' ? pe : null
    } catch { return null }
  })
  log('Private endpoint ready.', 'success')

  // ── Step 13: Private DNS zone ─────────────────────────────────────────────
  log(`Creating private DNS zone (${dnsZoneName})...`)
  await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/privateDnsZones/${dnsZoneName}?api-version=2020-06-01`,
    {
      method: 'PUT',
      body: JSON.stringify({
        location: 'global',
        tags: managedTags,
        properties: {},
      }),
    }
  )
  const dnsZoneFinal = await poll(async () => {
    try {
      const z = await armFetch(
        token,
        `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/privateDnsZones/${dnsZoneName}?api-version=2020-06-01`
      )
      return z?.properties?.provisioningState === 'Succeeded' ? z : null
    } catch { return null }
  })
  const dnsZoneId = dnsZoneFinal.id
  log('Private DNS zone created.', 'success')

  // ── Step 14: DNS zone VNet link ───────────────────────────────────────────
  log('Linking DNS zone to VNet...')
  await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/privateDnsZones/${dnsZoneName}/virtualNetworkLinks/link-autoshutdown?api-version=2020-06-01`,
    {
      method: 'PUT',
      body: JSON.stringify({
        location: 'global',
        properties: {
          virtualNetwork: { id: vnetId },
          registrationEnabled: false,
        },
      }),
    }
  )
  log('DNS zone linked to VNet.', 'success')

  // ── Step 15: DNS zone group on private endpoint ───────────────────────────
  log('Creating DNS zone group...')
  await armFetch(
    token,
    `${ARM}${peId}/privateDnsZoneGroups/default?api-version=2023-09-01`,
    {
      method: 'PUT',
      body: JSON.stringify({
        properties: {
          privateDnsZoneConfigs: [
            {
              name: 'config-blob',
              properties: { privateDnsZoneId: dnsZoneId },
            },
          ],
        },
      }),
    }
  )
  log('DNS zone group created.', 'success')

  // ── Step 16: Storage network restrictions (sa-05) ─────────────────────────
  log('Applying storage network restrictions (sa-05)...')
  await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/${storageAccountName}?api-version=2023-01-01`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        properties: {
          networkAcls: {
            defaultAction: 'Deny',
            bypass: 'AzureServices,Logging,Metrics',
            virtualNetworkRules: [{ id: flexSubnetId, action: 'Allow' }],
          },
        },
      }),
    }
  )
  log('Network restrictions applied.', 'success')

  // ── Step 17: Disable Shared Key (sa-07) ───────────────────────────────────
  log('Disabling Shared Key access (sa-07)...')
  await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/${storageAccountName}?api-version=2023-01-01`,
    {
      method: 'PATCH',
      body: JSON.stringify({ properties: { allowSharedKeyAccess: false } }),
    }
  )
  log('Shared Key access disabled.', 'success')

  // ── Step 18: Sync function triggers ──────────────────────────────────────
  // Tells the Flex Consumption scale controller to pick up function definitions
  // from the deployment package now that all infrastructure is in place.
  log('Syncing function triggers...')
  try {
    await armFetch(
      token,
      `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${functionAppName}/syncfunctiontriggers?api-version=2023-12-01`,
      { method: 'POST' }
    )
  } catch (e) {
    log(`Trigger sync: ${e.message}`, 'warn')
  }
  log('Function triggers synced.', 'success')

  // ── Step 19: Restart Function App ─────────────────────────────────────────
  // Resets the deployment controller so it re-reads the blob container with
  // all networking and RBAC now in place.
  log('Restarting Function App...')
  try {
    await armFetch(
      token,
      `${ARM}/subscriptions/${subId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${functionAppName}/restart?api-version=2024-04-01`,
      { method: 'POST' }
    )
  } catch (e) {
    log(`Restart: ${e.message}`, 'warn')
  }
  log('Function App restarted.', 'success')

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

// ── Uninstall ─────────────────────────────────────────────────────────────────

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

  const typeOrder = [
    'microsoft.web/sites',
    'microsoft.web/serverfarms',
    'microsoft.insights/components',
    'microsoft.network/privateendpoints',
    'microsoft.storage/storageaccounts',
    'microsoft.network/privatednszones',
    'microsoft.network/virtualnetworks',
    'microsoft.network/networksecuritygroups',
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
  if (t.includes('managedidentity'))  return '2023-01-31'
  if (t.includes('insights'))         return '2020-02-02'
  if (t.includes('privatednszones'))  return '2020-06-01'
  if (t.includes('network'))          return '2023-09-01'
  if (t.includes('web/'))             return '2024-04-01'
  return '2023-01-01'
}
