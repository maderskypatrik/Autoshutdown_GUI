export default function SubscriptionStatus({ status, currentVersion, onInstall, onUninstall, onUpdate }) {
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
        <span>AutoShutdown is <strong>not installed</strong> in this subscription.</span>
        <button className="btn btn-install" onClick={onInstall}>Install</button>
      </div>
    )
  }

  const updateAvailable = status.version !== currentVersion

  return (
    <div className="sub-status sub-status-installed">
      <span className="sub-status-icon">✓</span>
      <span>
        AutoShutdown is <strong>installed</strong>:&nbsp;
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
  )
}
