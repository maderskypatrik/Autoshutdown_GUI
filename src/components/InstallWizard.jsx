import { useState, useRef, useEffect } from 'react'
import { installAutoShutdown } from '../services/deploy'

const TIMEZONES = [
  'Central European Standard Time',
  'Eastern Standard Time',
  'Pacific Standard Time',
  'UTC',
  'GMT Standard Time',
  'W. Europe Standard Time',
  'Romance Standard Time',
  'Central Standard Time',
  'Mountain Standard Time',
  'AUS Eastern Standard Time',
  'Tokyo Standard Time',
  'China Standard Time',
  'India Standard Time',
  'Arab Standard Time',
]

export default function InstallWizard({ token, subId, subscriptionName, installedBy, resourceGroups, onClose, onInstalled }) {
  const [step, setStep]               = useState(1) // 1=ToU, 2=Config, 3=Progress
  const [agreed, setAgreed]           = useState(false)
  const [rg, setRg]                   = useState(resourceGroups[0]?.name ?? '')
  const [funcName, setFuncName]       = useState('aa-autoshutdown')
  const [timezone, setTimezone]       = useState('Central European Standard Time')
  const [running, setRunning]         = useState(false)
  const [done, setDone]               = useState(false)
  const [failed, setFailed]           = useState(false)
  const [log, setLog]                 = useState([])
  const logRef                        = useRef(null)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  function appendLog(entry) {
    setLog(prev => [...prev, entry])
  }

  async function handleInstall() {
    setStep(3)
    setRunning(true)
    setDone(false)
    setFailed(false)
    setLog([])
    try {
      await installAutoShutdown(token, subId, { resourceGroup: rg, functionAppName: funcName, timezone, subscriptionName, installedBy }, appendLog)
      setDone(true)
    } catch (e) {
      appendLog({ msg: `Installation failed: ${e.message}`, level: 'error' })
      setFailed(true)
    } finally {
      setRunning(false)
    }
  }

  function handleDone() {
    onInstalled()
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">Install AutoShutdown</span>
          {!running && (
            <button className="modal-close" onClick={onClose}>✕</button>
          )}
        </div>

        <div className="modal-steps">
          {['Terms of Use', 'Configuration', 'Install'].map((label, i) => (
            <div key={i} className={`modal-step ${step === i + 1 ? 'active' : step > i + 1 ? 'done' : ''}`}>
              <span className="step-num">{step > i + 1 ? '✓' : i + 1}</span>
              {label}
            </div>
          ))}
        </div>

        <div className="modal-body">

          {/* ── Step 1: Terms of Use ─────────────────────────────────────── */}
          {step === 1 && (
            <>
              <p className="wizard-intro">
                Before installing AutoShutdown into your Azure subscription, please read and accept the Terms of Use.
              </p>
              <div className="tou-box">
                <p><strong>What will be installed:</strong></p>
                <ul>
                  <li>Azure Automation Account with system-assigned managed identity and PowerShell runbooks (runs every 15 minutes)</li>
                </ul>
                <p><strong>Permissions granted to the Automation Account:</strong></p>
                <ul>
                  <li>Virtual Machine Contributor at subscription scope</li>
                  <li>Reader at subscription scope</li>
                  <li>Automation Contributor at Automation Account scope (required for self-update)</li>
                </ul>
                <p><strong>Estimated cost:</strong> Free tier (500 minutes/month included). Typical usage is well within the free tier.</p>
                <p><strong>Disclaimer:</strong> The PowerCloud Team accepts no responsibility for data loss, service interruption, or Azure costs resulting from use of this solution.</p>
                <p>
                  <a href="https://devstack.vwgroup.com/confluence/x/oN1ltgE" target="_blank" rel="noreferrer">View full Terms of Use ↗</a>
                </p>
              </div>
              <label className="tou-agree">
                <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} />
                I have read and agree to the Terms of Use
              </label>
              <div className="modal-footer">
                <button className="btn" onClick={onClose}>Cancel</button>
                <button className="btn btn-primary" disabled={!agreed} onClick={() => setStep(2)}>
                  Next →
                </button>
              </div>
            </>
          )}

          {/* ── Step 2: Configuration ────────────────────────────────────── */}
          {step === 2 && (
            <>
              <p className="wizard-intro">Configure the resources to deploy. The Automation Account name must be globally unique.</p>

              <div className="wizard-fields">
                <div className="wizard-field">
                  <label className="label">Resource Group</label>
                  <select className="select" value={rg} onChange={e => setRg(e.target.value)}>
                    {resourceGroups.map(g => (
                      <option key={g.name} value={g.name}>{g.name}</option>
                    ))}
                  </select>
                </div>

                <div className="wizard-field">
                  <label className="label">Automation Account Name</label>
                  <input
                    className="wizard-input"
                    value={funcName}
                    onChange={e => setFuncName(e.target.value.trim())}
                    placeholder="aa-autoshutdown"
                  />
                  <span className="wizard-hint">Must be globally unique within Azure</span>
                </div>

                <div className="wizard-field">
                  <label className="label">Timezone for shutdown/startup times</label>
                  <select className="select" value={timezone} onChange={e => setTimezone(e.target.value)}>
                    {TIMEZONES.map(tz => (
                      <option key={tz} value={tz}>{tz}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="modal-footer">
                <button className="btn" onClick={() => setStep(1)}>← Back</button>
                <button
                  className="btn btn-primary"
                  disabled={!rg || !funcName}
                  onClick={handleInstall}
                >
                  Install
                </button>
              </div>
            </>
          )}

          {/* ── Step 3: Progress ─────────────────────────────────────────── */}
          {step === 3 && (
            <>
              <p className="wizard-intro">
                {running && 'Deploying Azure resources — this takes a few minutes, please wait…'}
                {done    && 'Installation complete. The Automation Account runbooks will start on the next 15-minute interval.'}
                {failed  && 'Installation encountered an error. Review the log below.'}
              </p>
              <div className="install-log" ref={logRef}>
                {log.map((entry, i) => (
                  <div key={i} className={`log-line log-${entry.level}`}>
                    {entry.level === 'success' ? '✓ ' : entry.level === 'error' ? '✗ ' : entry.level === 'warn' ? '⚠ ' : '  '}
                    {entry.msg}
                  </div>
                ))}
                {running && <div className="log-line log-info">  …</div>}
              </div>
              <div className="modal-footer">
                {(done || failed) && (
                  <button className="btn btn-primary" onClick={handleDone}>
                    {done ? 'Done' : 'Close'}
                  </button>
                )}
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  )
}
