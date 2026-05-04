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
  query += `\n| project id, name, resourceGroup, tags, location
| order by name asc`

  const data = await armFetch(
    token,
    `${ARM}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`,
    {
      method: 'POST',
      body: JSON.stringify({
        query,
        subscriptions: [subId],
        options: { $top: 1000 },
      }),
    }
  )
  return data.data
}

// Replaces the entire tag set on a VM using the dedicated Tags API.
// This only touches tags — all other VM properties are untouched.
export async function updateVMTags(token, resourceId, tags) {
  await armFetch(
    token,
    `${ARM}${resourceId}/providers/Microsoft.Resources/tags/default?api-version=2021-04-01`,
    {
      method: 'PUT',
      body: JSON.stringify({ properties: { tags } }),
    }
  )
}

// Returns true if the current user has Microsoft.Compute/virtualMachines/write
// on the given VM resource ID (i.e. VM Contributor or Owner).
export async function checkVMWritePermission(token, vmResourceId) {
  try {
    const data = await armFetch(
      token,
      `${ARM}${vmResourceId}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01`
    )
    return (data?.value ?? []).some(p =>
      (p.actions ?? []).some(a => actionCovers(a, 'Microsoft.Compute/virtualMachines/write')) &&
      !(p.notActions ?? []).some(a => actionCovers(a, 'Microsoft.Compute/virtualMachines/write'))
    )
  } catch {
    return false
  }
}

function actionCovers(pattern, target) {
  if (pattern === '*') return true
  const p = pattern.toLowerCase().split('/')
  const t = target.toLowerCase().split('/')
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '*') return true
    if (p[i] !== (t[i] ?? '')) return false
  }
  return p.length === t.length
}
