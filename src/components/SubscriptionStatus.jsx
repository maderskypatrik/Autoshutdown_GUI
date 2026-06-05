import { useState, useEffect } from 'react'

function NotificationEmails({ emails, onSave }) {
  const [input, setInput]     = useState(emails.join(', '))
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState(null)

  useEffect(() => { setInput(emails.join(', ')) }, [emails])

  const parsed  = input.split(',').map(e => e.trim()).filter(Boolean)
  const isDirty = parsed.join(',') !== emails.join(',')

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      await onSave(parsed)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="notif-row">
      <span className="notif-label">Failure notifications:</span>
      <input
        className="notif-input"
        value={input}
        onChange={e => { setInput(e.target.value); setError(null) }}
        placeholder="user@example.com, other@example.com — leave empty to disable"
        disabled={saving}
      />
      {isDirty && (
        <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      )}
      {error && <span className="notif-error">{error}</span>}
    </div>
  )
}

export default function SubscriptionStatus({ status, currentVersion, onInstall, onUninstall, onUpdate, onSaveEmails }) {
  if (!status) return null

  if (status === 'checking') {
    return (
      <div className="sub-status sub-status-checking">
        <span className="sub-status-icon">⏳</span>
        Checking AutoShutdown status…
      </div>
    )
  }

  if (!status.installed) {
    return (
      <div className="sub-status sub-status-not-installed">
        <span className="sub-status-icon">○</span>
        <span>VM Scheduler is <strong>not installed</strong> in this subscription.</span>
        <button className="btn btn-install" onClick={onInstall}>Install</button>
      </div>
    )
  }

  const updateAvailable = status.version !== currentVersion

  return (
    <>
      <div className="sub-status sub-status-installed">
        <span className="sub-status-icon">✓</span>
        <span>
          VM Scheduler is <strong>installed</strong>:&nbsp;
          <span className="sub-status-detail">{status.functionAppName}</span>
          <span className="sub-status-sep">·</span>
          <span className="sub-status-detail">{status.resourceGroup}</span>
        </span>
        <div className="sub-status-actions">
          {updateAvailable && (
            <button className="btn btn-update" onClick={onUpdate}>Update available</button>
          )}
          <button className="btn btn-uninstall" onClick={onUninstall}>Uninstall</button>
        </div>
      </div>
      <NotificationEmails
        emails={status.notificationEmails ?? []}
        onSave={onSaveEmails}
      />
    </>
  )
}
