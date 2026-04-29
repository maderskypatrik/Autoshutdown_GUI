import { useState, useRef, useEffect } from 'react'
import { uninstallAutoShutdown } from '../services/deploy'

export default function UninstallDialog({ token, subId, installation, onClose, onUninstalled }) {
  const [step, setStep]     = useState(1) // 1=confirm, 2=progress
  const [running, setRunning] = useState(false)
  const [done, setDone]     = useState(false)
  const [failed, setFailed] = useState(false)
  const [log, setLog]       = useState([])
  const logRef              = useRef(null)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  async function handleUninstall() {
    setStep(2)
    setRunning(true)
    setLog([])
    try {
      await uninstallAutoShutdown(token, subId, installation, entry => setLog(prev => [...prev, entry]))
      setDone(true)
    } catch (e) {
      setLog(prev => [...prev, { msg: `Uninstall failed: ${e.message}`, level: 'error' }])
      setFailed(true)
    } finally {
      setRunning(false)
    }
  }

  function handleDone() {
    onUninstalled()
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal modal-sm">
        <div className="modal-header">
          <span className="modal-title">Uninstall AutoShutdown V3</span>
          {!running && <button className="modal-close" onClick={onClose}>✕</button>}
        </div>

        <div className="modal-body">

          {step === 1 && (
            <>
              <p className="wizard-intro">
                This will permanently remove all AutoShutdown V3 resources from subscription and delete the RBAC role assignments.
              </p>
              <div className="uninstall-info">
                <p><strong>Resources to be deleted:</strong></p>
                <ul>
                  <li>Function App: <strong>{installation.functionAppName}</strong></li>
                  <li>App Service Plan: plan-autoshutdown</li>
                  <li>Storage Account (stautoshutdown…)</li>
                  <li>User-Assigned Managed Identity: mi-autoshutdown</li>
                  <li>RBAC role assignments (VM Contributor, Reader)</li>
                </ul>
                <p className="uninstall-note">VM tags are not modified. VMs will simply no longer be acted on after removal.</p>
              </div>
              <div className="modal-footer">
                <button className="btn" onClick={onClose}>Cancel</button>
                <button className="btn btn-danger" onClick={handleUninstall}>Remove All Resources</button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <p className="wizard-intro">
                {running && 'Removing resources…'}
                {done    && 'All AutoShutdown V3 resources have been removed.'}
                {failed  && 'Uninstall encountered an error. Some resources may remain — check the Azure Portal.'}
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
                  <button className="btn btn-primary" onClick={handleDone}>Close</button>
                )}
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  )
}
