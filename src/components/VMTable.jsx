import { useState } from 'react'

const TIME_RE = /^\d{1,2}:\d{2}$/

function isValidTime(v) {
  if (!v) return true // empty = remove tag, that's valid
  return TIME_RE.test(v)
}

function VMRow({ vm, edit, onEdit, dirty }) {
  const enrolled       = !!(edit.shutdown || edit.startup)
  const badShutdown    = !isValidTime(edit.shutdown)
  const badStartup     = !isValidTime(edit.startup)

  return (
    <tr className={dirty ? 'row-dirty' : ''}>
      {/* VM Name */}
      <td className="td-name">
        <span className="vm-name">{vm.name}</span>
        {dirty && <span className="badge badge-modified">modified</span>}
      </td>

      {/* Resource Group */}
      <td className="td-rg">{vm.resourceGroup}</td>

      {/* Location */}
      <td className="td-location">{vm.location}</td>

      {/* Shutdown time */}
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

      {/* Exclude from shutdown */}
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

      {/* Startup time */}
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

      {/* Exclude from startup */}
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

      {/* Enrollment status */}
      <td className="td-status">
        {enrolled
          ? <span className="badge badge-enrolled">Enrolled</span>
          : <span className="badge badge-none">Not enrolled</span>
        }
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

  const enrolledCount = vms.filter(vm => {
    const e = edits[vm.id]
    return e && (e.shutdown || e.startup)
  }).length

  return (
    <div className="table-wrap">
      <div className="table-toolbar">
        <span className="table-count">
          {vms.length} VM{vms.length !== 1 ? 's' : ''}
          &nbsp;&middot;&nbsp;
          <span className="enrolled-count">{enrolledCount} enrolled</span>
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
              <th colSpan={2} className="th-group">Shutdown</th>
              <th colSpan={2} className="th-group">Startup</th>
              <th rowSpan={2}>Status</th>
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
                <td colSpan={8} className="td-empty">No VMs match the filter.</td>
              </tr>
            ) : (
              filtered.map(vm => (
                <VMRow
                  key={vm.id}
                  vm={vm}
                  edit={edits[vm.id] ?? { shutdown: '', startup: '', noShutdown: false, noStart: false }}
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
