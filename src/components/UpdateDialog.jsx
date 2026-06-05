import { useState, useRef, useEffect } from 'react'
import { updateRunbooks } from '../services/deploy'

export default function UpdateDialog({ token, subId, installation, onClose, onUpdated }) {
  const [step, setStep]       = useState(1)
  const [running, setRunning] = useState(false)
  const [done, setDone]       = useState(false)
  const [failed, setFailed]   = useState(false)
  const [log, setLog]         = useState([])
  const logRef                = useRef(null)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  async function handleUpdate() {
    setStep(2)
    setRunning(true)
    setLog([])
    try {
      await updateRunbooks(token, subId, installation, entry => setLog(prev => [...prev, entry]))
      setDone(true)
    } catch (e) {
      setLog(prev => [...prev, { msg: `Update failed: ${e.message}`, level: 'error' }])
      setFailed(true)
    } finally {
      setRunning(false)
    }
  }

  function handleDone() {
    onUpdated()
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal modal-sm">
        <div className="modal-header">
          <span className="modal-title">Update VM Scheduler</span>
          {!running && <button className="modal-close" onClick={onClose}>✕</button>}
        </div>
        <div className="modal-body">

          {step === 1 && (
            <>
              <p className="wizard-intro">
                A new version of the VM Scheduler runbooks is available. This will re-publish
                the runbooks in <strong>{installation.automationAccountName}</strong> without
                removing any resources, schedules, or role assignments.
              </p>
              <div className="modal-footer">
                <button className="btn" onClick={onClose}>Cancel</button>
                <button className="btn btn-primary" onClick={handleUpdate}>Update Runbooks</button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <p className="wizard-intro">
                {running && 'Updating runbooks — this takes a minute, please wait…'}
                {done    && 'Runbooks updated successfully.'}
                {failed  && 'Update encountered an error. Review the log below.'}
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
