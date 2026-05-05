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
  // Use Resource Graph for a single fast call that returns tags alongside VM metadata
  let query = `Resources
| where type =~ 'microsoft.compute/virtualmachines'`
  if (rg) query += `\n| where resourceGroup =~ '${rg}'`
  query += `\n| project id, name, resourceGroup, tags, location,
    powerState = tostring(properties.extended.instanceView.powerState.displayStatus)
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
  return all
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
