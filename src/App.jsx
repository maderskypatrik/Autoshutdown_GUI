import { useState, useEffect, useCallback } from 'react'
import { useIsAuthenticated, useMsal } from '@azure/msal-react'
import { InteractionRequiredAuthError } from '@azure/msal-browser'
import { armScopes } from './authConfig'
import { getSubscriptions, getResourceGroups, getVMs, updateVMTags } from './services/azure'
import LoginPage from './components/LoginPage'
import Header from './components/Header'
import Controls from './components/Controls'
import VMTable from './components/VMTable'

// Case-insensitive tag helpers — VM tags in Azure can have any casing
function getTagCI(tags, key) {
  if (!tags) return undefined
  const lk = key.toLowerCase()
  for (const [k, v] of Object.entries(tags)) {
    if (k.toLowerCase() === lk) return v
  }
  return undefined
}
function hasTagCI(tags, key) {
  if (!tags) return false
  const lk = key.toLowerCase()
  return Object.keys(tags).some(k => k.toLowerCase() === lk)
}

function isValidTime(v) {
  if (!v) return true
  return /^\d{1,2}:\d{2}$/.test(v)
}

function vmToEdit(vm) {
  return {
    shutdown:    getTagCI(vm.tags, 'shutdown')    ?? '',
    startup:     getTagCI(vm.tags, 'startup')     ?? '',
    noShutdown:  hasTagCI(vm.tags, 'donotshutdown'),
    noStart:     hasTagCI(vm.tags, 'donotstart'),
  }
}

export default function App() {
  const isAuthenticated        = useIsAuthenticated()
  const { instance, accounts } = useMsal()

  const [subscriptions, setSubscriptions] = useState([])
  const [subsLoading,   setSubsLoading]   = useState(false)
  const [selectedSubId, setSelectedSubId] = useState('')
  const [resourceGroups, setResourceGroups] = useState([])
  const [selectedRg,    setSelectedRg]    = useState('')
  const [vms,           setVms]           = useState([])
  const [edits,         setEdits]         = useState({})
  const [loading,       setLoading]       = useState(false)
  const [saving,        setSaving]        = useState(false)
  const [error,         setError]         = useState(null)
  const [saveResult,    setSaveResult]    = useState(null)

  // Acquire ARM token — silent first, popup fallback
  const getToken = useCallback(async () => {
    try {
      const r = await instance.acquireTokenSilent({ scopes: armScopes, account: accounts[0] })
      return r.accessToken
    } catch (e) {
      if (e instanceof InteractionRequiredAuthError) {
        const r = await instance.acquireTokenPopup({ scopes: armScopes })
        return r.accessToken
      }
      throw e
    }
  }, [instance, accounts])

  // Load subscriptions once the user is authenticated
  useEffect(() => {
    if (!isAuthenticated) return
    setSubsLoading(true)
    getToken()
      .then(token => getSubscriptions(token))
      .then(subs => setSubscriptions(subs.sort((a, b) => a.displayName.localeCompare(b.displayName))))
      .catch(e => setError(`Failed to load subscriptions: ${e.message}`))
      .finally(() => setSubsLoading(false))
  }, [isAuthenticated]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubChange = async (subId) => {
    setSelectedSubId(subId)
    setSelectedRg('')
    setVms([])
    setEdits({})
    setResourceGroups([])
    setSaveResult(null)
    setError(null)
    if (!subId) return
    setLoading(true)
    try {
      const token = await getToken()
      const rgs = await getResourceGroups(token, subId)
      setResourceGroups(rgs.sort((a, b) => a.name.localeCompare(b.name)))
    } catch (e) {
      setError(`Failed to load resource groups: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  const handleLoadVMs = async () => {
    if (!selectedSubId) return
    setLoading(true)
    setError(null)
    setVms([])
    setEdits({})
    setSaveResult(null)
    try {
      const token  = await getToken()
      const vmList = await getVMs(token, selectedSubId, selectedRg || null)
      setVms(vmList)
      const init = {}
      for (const vm of vmList) init[vm.id] = vmToEdit(vm)
      setEdits(init)
    } catch (e) {
      setError(`Failed to load VMs: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  const handleEdit = (vmId, field, value) => {
    setEdits(prev => ({ ...prev, [vmId]: { ...prev[vmId], [field]: value } }))
    setSaveResult(null)
  }

  const isDirty = (vm) => {
    const e = edits[vm.id]
    if (!e) return false
    const o = vmToEdit(vm)
    return e.shutdown !== o.shutdown || e.startup !== o.startup ||
           e.noShutdown !== o.noShutdown || e.noStart !== o.noStart
  }

  const dirtyVMs = vms.filter(isDirty)

  const hasInvalidTimes = dirtyVMs.some(vm => {
    const e = edits[vm.id]
    return !isValidTime(e.shutdown) || !isValidTime(e.startup)
  })

  const handleSave = async () => {
    setSaving(true)
    setSaveResult(null)
    setError(null)
    const errors = []
    const saved  = [] // { vmId, newTags }
    try {
      const token = await getToken()
      for (const vm of dirtyVMs) {
        const e = edits[vm.id]

        // Start with all existing tags, strip managed keys case-insensitively
        let newTags = { ...(vm.tags ?? {}) }
        for (const key of ['shutdown', 'startup', 'donotshutdown', 'donotstart']) {
          for (const k of Object.keys(newTags)) {
            if (k.toLowerCase() === key) delete newTags[k]
          }
        }
        // Apply edits
        if (e.shutdown)    newTags.shutdown       = e.shutdown
        if (e.startup)     newTags.startup        = e.startup
        if (e.noShutdown)  newTags.donotshutdown  = 'true'
        if (e.noStart)     newTags.donotstart     = 'true'

        try {
          await updateVMTags(token, vm.id, newTags)
          saved.push({ vmId: vm.id, newTags })
        } catch (err) {
          errors.push(`${vm.name}: ${err.message}`)
        }
      }

      // Update local state so saved rows are no longer dirty
      if (saved.length > 0) {
        setVms(prev => prev.map(v => {
          const s = saved.find(x => x.vmId === v.id)
          return s ? { ...v, tags: s.newTags } : v
        }))
        setEdits(prev => {
          const next = { ...prev }
          for (const { vmId, newTags } of saved) {
            next[vmId] = {
              shutdown:   getTagCI(newTags, 'shutdown')   ?? '',
              startup:    getTagCI(newTags, 'startup')    ?? '',
              noShutdown: hasTagCI(newTags, 'donotshutdown'),
              noStart:    hasTagCI(newTags, 'donotstart'),
            }
          }
          return next
        })
      }

      if (errors.length) {
        setSaveResult({ type: 'error', text: `${saved.length} saved, ${errors.length} failed: ${errors.join('; ')}` })
      } else {
        setSaveResult({ type: 'success', text: `${saved.length} VM${saved.length !== 1 ? 's' : ''} updated successfully.` })
      }
    } catch (e) {
      setError(`Save failed: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  if (!isAuthenticated) return <LoginPage />

  return (
    <div className="app">
      <Header account={accounts[0]} />
      <main className="main">
        <Controls
          subscriptions={subscriptions}
          subsLoading={subsLoading}
          selectedSubId={selectedSubId}
          resourceGroups={resourceGroups}
          selectedRg={selectedRg}
          loading={loading}
          onSubChange={handleSubChange}
          onRgChange={setSelectedRg}
          onLoad={handleLoadVMs}
        />

        {error && <div className="banner banner-error">{error}</div>}

        {loading && (
          <div className="spinner-wrap"><div className="spinner" /></div>
        )}

        {!loading && vms.length > 0 && (
          <VMTable vms={vms} edits={edits} onEdit={handleEdit} isDirty={isDirty} />
        )}

        {!loading && vms.length === 0 && selectedSubId && (
          <div className="empty">
            Select a Resource Group (optional) and click <strong>Load VMs</strong>.
          </div>
        )}

        {!loading && !selectedSubId && (
          <div className="empty">Select a subscription above to get started.</div>
        )}
      </main>

      {vms.length > 0 && (
        <footer className="save-bar">
          <div className="save-bar-info">
            {dirtyVMs.length > 0
              ? <span className="dirty-count">{dirtyVMs.length} VM{dirtyVMs.length !== 1 ? 's' : ''} with unsaved changes</span>
              : <span className="no-changes">No pending changes</span>
            }
            {saveResult && (
              <span className={`save-msg save-msg-${saveResult.type}`}>{saveResult.text}</span>
            )}
          </div>
          <div className="save-bar-actions">
            {hasInvalidTimes && (
              <span className="validation-warn">Fix invalid time values (use HH:mm) before saving.</span>
            )}
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving || dirtyVMs.length === 0 || hasInvalidTimes}
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </footer>
      )}
    </div>
  )
}
