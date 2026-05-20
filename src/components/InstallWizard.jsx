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

export default function InstallWizard({ token, subId, resourceGroups, onClose, onInstalled }) {
  const [step, setStep]               = useState(1) // 1=ToU, 2=Config, 3=Progress
  const [agreed, setAgreed]           = useState(false)
  const [rg, setRg]                   = useState(resourceGroups[0]?.name ?? '')
  const [funcName, setFuncName]       = useState('func-autoshutdown')
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
      await installAutoShutdown(token, subId, { resourceGroup: rg, functionAppName: funcName, timezone }, appendLog)
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
                Before installing the AutoShutdown Function App into your Azure subscription, please read and accept the Terms of Use.
              </p>
              <div className="tou-box">
                <p><strong>What will be installed:</strong></p>
                <ul>
                  <li>User-Assigned Managed Identity</li>
                  <li>Storage Account (Standard LRS)</li>
                  <li>App Service Plan (Consumption, ~free)</li>
                  <li>Function App (PowerShell 7.4, runs every 15 minutes)</li>
                </ul>
                <p><strong>Permissions granted to the Function App:</strong></p>
                <ul>
                  <li>Virtual Machine Contributor at subscription scope</li>
                  <li>Reader at subscription scope</li>
                  <li>Website Contributor at resource group scope (required for self-update)</li>
                </ul>
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
              <p className="wizard-intro">Configure the resources to deploy. Names must be unique within the subscription (storage account name is auto-generated).</p>

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
                  <label className="label">Function App Name</label>
                  <input
                    className="wizard-input"
                    value={funcName}
                    onChange={e => setFuncName(e.target.value.trim())}
                    placeholder="func-autoshutdown"
                  />
                  <span className="wizard-hint">Must be globally unique — becomes {funcName || 'func-autoshutdown'}.azurewebsites.net</span>
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
                {running && 'Deploying Azure resources — this takes 1–3 minutes, please wait…'}
                {done    && 'Installation complete. The Function App will be ready within a few minutes.'}
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
