export default function Controls({
  subscriptions, subsLoading,
  selectedSubId,
  resourceGroups, selectedRg,
  loading,
  onSubChange, onRgChange, onLoad,
}) {
  return (
    <div className="controls">
      <div className="controls-row">
        <div className="control-group">
          <label className="label">Subscription</label>
          <select
            className="select"
            value={selectedSubId}
            onChange={e => onSubChange(e.target.value)}
            disabled={subsLoading}
          >
            <option value="">
              {subsLoading ? 'Loading subscriptions…' : '— Select a subscription —'}
            </option>
            {subscriptions.map(s => (
              <option key={s.subscriptionId} value={s.subscriptionId}>
                {s.displayName}
              </option>
            ))}
          </select>
        </div>

        <div className="control-group">
          <label className="label">Resource Group</label>
          <select
            className="select"
            value={selectedRg}
            onChange={e => onRgChange(e.target.value)}
            disabled={!selectedSubId || loading}
          >
            <option value="">All Resource Groups</option>
            {resourceGroups.map(rg => (
              <option key={rg.name} value={rg.name}>{rg.name}</option>
            ))}
          </select>
        </div>

        <div className="control-action">
          <label className="label">&nbsp;</label>
          <button
            className="btn btn-primary"
            onClick={onLoad}
            disabled={!selectedSubId || loading}
          >
            {loading ? 'Loading…' : 'Load VMs'}
          </button>
        </div>
      </div>
    </div>
  )
}
