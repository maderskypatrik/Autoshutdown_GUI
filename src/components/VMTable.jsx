import { useState } from 'react'

const TIME_RE = /^\d{1,2}:\d{2}$/

function isValidTime(v) {
  if (!v) return true
  return TIME_RE.test(v)
}

function StatusBadge({ powerState }) {
  if (!powerState) return <span className="badge badge-status-unknown">Unknown</span>
  const s = powerState.toLowerCase()
  if (s.includes('running'))    return <span className="badge badge-status-running">Running</span>
  if (s.includes('deallocated') || s.includes('stopped')) return <span className="badge badge-status-stopped">Stopped</span>
  return <span className="badge badge-status-transitioning">{powerState.replace(/^VM /i, '')}</span>
}

function VMRow({ vm, edit, onEdit, dirty }) {
  const badShutdown = !isValidTime(edit.shutdown)
  const badStartup  = !isValidTime(edit.startup)

  return (
    <tr className={dirty ? 'row-dirty' : ''}>
      <td className="td-name">
        <span className="vm-name">{vm.name}</span>
        {dirty && <span className="badge badge-modified">modified</span>}
      </td>

      <td className="td-rg">{vm.resourceGroup}</td>

      <td className="td-location">{vm.location}</td>

      <td className="td-status">
        <StatusBadge powerState={vm.powerState} />
      </td>

      <td className="td-time">
        <input
          type="text"
          className={`time-input${badShutdown ? ' time-input-invalid' : ''}`}
          placeholder="HH:mm"
          value={edit.shutdown}
          onChange={e => onEdit(vm.id, 'shutdown', e.target.value)}
          disabled={edit.noShutdown}
          maxLength={5}
          title="Shutdown time in HH:mm local time, e.g. 18:30. Leave empty to remove."
        />
        {badShutdown && <span className="field-error">Use HH:mm</span>}
      </td>

      <td className="td-toggle">
        <label className="toggle" title="Tag VM with donotshutdown — automation will skip it">
          <input
            type="checkbox"
            checked={edit.noShutdown}
            onChange={e => onEdit(vm.id, 'noShutdown', e.target.checked)}
          />
          <span>Exclude</span>
        </label>
      </td>

      <td className="td-time">
        <input
          type="text"
          className={`time-input${badStartup ? ' time-input-invalid' : ''}`}
          placeholder="HH:mm"
          value={edit.startup}
          onChange={e => onEdit(vm.id, 'startup', e.target.value)}
          disabled={edit.noStart}
          maxLength={5}
          title="Startup time in HH:mm local time, e.g. 07:00. Leave empty to remove."
        />
        {badStartup && <span className="field-error">Use HH:mm</span>}
      </td>

      <td className="td-toggle">
        <label className="toggle" title="Tag VM with donotstart — automation will skip it">
          <input
            type="checkbox"
            checked={edit.noStart}
            onChange={e => onEdit(vm.id, 'noStart', e.target.checked)}
          />
          <span>Exclude</span>
        </label>
      </td>

      <td className="td-toggle">
        <label className="toggle" title="Tag VM with autoshutdown-weekdays-only — skip shutdown and startup on Saturday and Sunday">
          <input
            type="checkbox"
            checked={edit.weekdaysOnly}
            onChange={e => onEdit(vm.id, 'weekdaysOnly', e.target.checked)}
          />
          <span>Mon–Fri</span>
        </label>
      </td>
    </tr>
  )
}

export default function VMTable({ vms, edits, onEdit, isDirty }) {
  const [search, setSearch] = useState('')

  const filtered = vms.filter(vm =>
    !search ||
    vm.name.toLowerCase().includes(search.toLowerCase()) ||
    vm.resourceGroup.toLowerCase().includes(search.toLowerCase())
  )

  const scheduledCount = vms.filter(vm => edits[vm.id]?.shutdown || edits[vm.id]?.startup).length

  return (
    <div className="table-wrap">
      <div className="table-toolbar">
        <span className="table-count">
          {vms.length} VM{vms.length !== 1 ? 's' : ''}
          &nbsp;&middot;&nbsp;
          <span className="scheduled-count">{scheduledCount} scheduled</span>
        </span>
        <input
          type="search"
          className="search-input"
          placeholder="Filter by name or resource group…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="table-scroll">
        <table className="vm-table">
          <thead>
            <tr>
              <th rowSpan={2} className="th-first">VM Name</th>
              <th rowSpan={2}>Resource Group</th>
              <th rowSpan={2}>Location</th>
              <th rowSpan={2}>Status</th>
              <th colSpan={2} className="th-group">Shutdown</th>
              <th colSpan={2} className="th-group">Startup</th>
              <th rowSpan={2}>Weekdays only</th>
            </tr>
            <tr className="th-sub">
              <th>Time</th>
              <th>Exclude</th>
              <th>Time</th>
              <th>Exclude</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={9} className="td-empty">No VMs match the filter.</td>
              </tr>
            ) : (
              filtered.map(vm => (
                <VMRow
                  key={vm.id}
                  vm={vm}
                  edit={edits[vm.id] ?? { shutdown: '', startup: '', noShutdown: false, noStart: false, weekdaysOnly: false }}
                  onEdit={onEdit}
                  dirty={isDirty(vm)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
