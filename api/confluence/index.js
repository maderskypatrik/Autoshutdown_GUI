const BASE_URL = process.env.CONFLUENCE_BASE_URL  // e.g. https://devstack.vwgroup.com/confluence
const PAGE_ID  = process.env.CONFLUENCE_PAGE_ID
const TOKEN    = process.env.CONFLUENCE_TOKEN

async function getPage() {
  const resp = await fetch(
    `${BASE_URL}/rest/api/content/${PAGE_ID}?expand=body.storage,version`,
    { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } }
  )
  if (!resp.ok) throw new Error(`Confluence GET failed: HTTP ${resp.status}`)
  return resp.json()
}

async function updatePage(page, newBody) {
  const resp = await fetch(`${BASE_URL}/rest/api/content/${PAGE_ID}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      version: { number: page.version.number + 1 },
      title: page.title,
      type: 'page',
      body: { storage: { value: newBody, representation: 'storage' } },
    }),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Confluence PUT failed: HTTP ${resp.status} — ${text.slice(0, 300)}`)
  }
}

function addRow(body, { subscriptionName, subscriptionId, installedBy, automationAccountName }) {
  const date = new Date().toISOString().split('T')[0]
  const row = [
    '<tr>',
    `<td><p>${subscriptionName}</p></td>`,
    `<td><p>${subscriptionId}</p></td>`,
    `<td><p>${date}</p></td>`,
    `<td><p>${installedBy}</p></td>`,
    `<td><p>${automationAccountName}</p></td>`,
    '</tr>',
  ].join('')
  if (body.includes('</tbody>')) return body.replace('</tbody>', row + '</tbody>')
  if (body.includes('</table>')) return body.replace('</table>', row + '</table>')
  return body + row
}

function removeRow(body, subscriptionId) {
  return body.replace(/<tr>[\s\S]*?<\/tr>/g, match =>
    match.includes(subscriptionId) ? '' : match
  )
}

module.exports = async function (context, req) {
  const { action, subscriptionId, subscriptionName, automationAccountName, installedBy } = req.body ?? {}

  if (!action || !subscriptionId) {
    context.res = { status: 400, body: { error: 'action and subscriptionId are required' } }
    return
  }
  if (!BASE_URL || !PAGE_ID || !TOKEN) {
    context.res = { status: 500, body: { error: 'Confluence environment variables not configured' } }
    return
  }

  try {
    const page = await getPage()
    let body = page.body.storage.value

    if (action === 'add') {
      body = removeRow(body, subscriptionId)  // remove stale entry first (idempotent)
      body = addRow(body, { subscriptionName, subscriptionId, installedBy, automationAccountName })
    } else if (action === 'remove') {
      body = removeRow(body, subscriptionId)
    } else {
      context.res = { status: 400, body: { error: `Unknown action: ${action}` } }
      return
    }

    await updatePage(page, body)
    context.res = { status: 200, body: { success: true } }
  } catch (e) {
    context.res = { status: 500, body: { error: e.message } }
  }
}
