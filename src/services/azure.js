const ARM = 'https://management.azure.com'

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
  if (res.status === 204) return null
  return res.json()
}

export async function getSubscriptions(token) {
  const data = await armFetch(token, `${ARM}/subscriptions?api-version=2022-12-01`)
  return data.value
}

export async function getResourceGroups(token, subId) {
  const data = await armFetch(
    token,
    `${ARM}/subscriptions/${subId}/resourcegroups?api-version=2021-04-01`
  )
  return data.value
}

export async function getVMs(token, subId, rg = null) {
  // Phase 1: Resource Graph — tags and metadata in a single fast call
  let query = `Resources
| where type =~ 'microsoft.compute/virtualmachines'`
  if (rg) query += `\n| where resourceGroup =~ '${rg}'`
  query += `\n| project id, name, resourceGroup, tags, location
| order by name asc`

  const all = []
  let skipToken = null
  do {
    const options = skipToken ? { $top: 1000, $skipToken: skipToken } : { $top: 1000 }
    const data = await armFetch(
      token,
      `${ARM}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`,
      {
        method: 'POST',
        body: JSON.stringify({ query, subscriptions: [subId], options }),
      }
    )
    all.push(...(data.data ?? []))
    skipToken = data.$skipToken ?? null
  } while (skipToken)

  // Phase 2: ARM instanceView — real-time power state (Resource Graph lags by minutes)
  const powerStates = {}
  try {
    let url = `${ARM}/subscriptions/${subId}/providers/Microsoft.Compute/virtualMachines?statusOnly=true&api-version=2024-03-01`
    while (url) {
      const resp = await armFetch(token, url)
      for (const vm of resp.value ?? []) {
        const s = (vm.properties?.instanceView?.statuses ?? []).find(s => s.code?.startsWith('PowerState/'))
        if (s) powerStates[vm.id.toLowerCase()] = s.displayStatus
      }
      url = resp.nextLink ?? null
    }
  } catch { /* fallback: powerState will be empty → shown as Unknown */ }

  return all.map(vm => ({ ...vm, powerState: powerStates[vm.id.toLowerCase()] ?? '' }))
}

// Updates VM tags via the VM PATCH API, which requires Microsoft.Compute/virtualMachines/write.
// Azure enforces the permission — Tag Contributor and below receive a 403.
export async function patchVMTags(token, resourceId, tags) {
  await armFetch(
    token,
    `${ARM}${resourceId}?api-version=2024-03-01`,
    {
      method: 'PATCH',
      body: JSON.stringify({ tags }),
    }
  )
}
