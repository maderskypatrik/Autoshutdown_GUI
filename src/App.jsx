import { useState, useEffect, useCallback } from 'react'
import { useIsAuthenticated, useMsal } from '@azure/msal-react'
import { InteractionRequiredAuthError } from '@azure/msal-browser'
import { armScopes } from './authConfig'
import { getSubscriptions, getResourceGroups, getVMs, updateVMTags, patchVMTags } from './services/azure'
import { detectInstallation } from './services/deploy'
import LoginPage from './components/LoginPage'
import Header from './components/Header'
import Controls from './components/Controls'
import VMTable from './components/VMTable'
import SubscriptionStatus from './components/SubscriptionStatus'
import InstallWizard from './components/InstallWizard'
import UninstallDialog from './components/UninstallDialog'

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
    shutdown:   getTagCI(vm.tags, 'shutdown')   ?? '',
    startup:    getTagCI(vm.tags, 'startup')    ?? '',
    noShutdown: hasTagCI(vm.tags, 'donotshutdown'),
    noStart:    hasTagCI(vm.tags, 'donotstart'),
    enrolled:   hasTagCI(vm.tags, 'autoshutdown-enrolled'),
  }
}

export default function App() {
  const isAuthenticated        = useIsAuthenticated()
  const { instance, accounts } = useMsal()

  const [subscriptions,  setSubscriptions]  = useState([])
  const [subsLoading,    setSubsLoading]    = useState(false)
  const [selectedSubId,  setSelectedSubId]  = useState('')
  const [resourceGroups, setResourceGroups] = useState([])
  const [selectedRg,     setSelectedRg]     = useState('')
  const [vms,            setVms]            = useState([])
  const [edits,          setEdits]          = useState({})
  const [loading,        setLoading]        = useState(false)
  const [saving,         setSaving]         = useState(false)
  const [error,          setError]          = useState(null)
  const [saveResult,     setSaveResult]     = useState(null)

  // null = no sub selected, 'checking', { installed: false }, { installed: true, ...details }
  const [installStatus,    setInstallStatus]    = useState(null)
  const [showInstallWizard, setShowInstallWizard] = useState(false)
  const [showUninstall,     setShowUninstall]     = useState(false)
  const [cachedToken,       setCachedToken]       = useState(null)
  const [enrolling,         setEnrolling]         = useState({})

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
    setInstallStatus(null)
    setCachedToken(null)
    if (!subId) return
    setLoading(true)
    setInstallStatus('checking')
    try {
      const token = await getToken()
      setCachedToken(token)
      const [rgs, installation] = await Promise.all([
        getResourceGroups(token, subId),
        detectInstallation(token, subId),
      ])
      setResourceGroups(rgs.sort((a, b) => a.name.localeCompare(b.name)))
      setInstallStatus(installation ? { installed: true, ...installation } : { installed: false })
    } catch (e) {
      setError(`Failed to load subscription data: ${e.message}`)
      setInstallStatus(null)
    } finally {
      setLoading(false)
    }
  }

  const refreshInstallStatus = async () => {
    try {
      const token = await getToken()
      setCachedToken(token)
      const installation = await detectInstallation(token, selectedSubId)
      setInstallStatus(installation ? { installed: true, ...installation } : { installed: false })
    } catch {}
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
      setCachedToken(token)
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

  const handleEnroll = async (vmId) => {
    setEnrolling(prev => ({ ...prev, [vmId]: true }))
    setError(null)
    try {
      const token = await getToken()
      const vm = vms.find(v => v.id === vmId)
      const newTags = { ...(vm.tags ?? {}), 'autoshutdown-enrolled': 'true' }
      await patchVMTags(token, vmId, newTags)
      setVms(prev => prev.map(v => v.id === vmId ? { ...v, tags: newTags } : v))
      setEdits(prev => ({ ...prev, [vmId]: { ...prev[vmId], enrolled: true } }))
    } catch (e) {
      const isAuthz = e.message.includes('403') || e.message.toLowerCase().includes('authorization')
      setError(isAuthz
        ? 'You need Virtual Machine Contributor or Owner role on this VM to enroll it.'
        : `Failed to enroll VM: ${e.message}`)
    } finally {
      setEnrolling(prev => ({ ...prev, [vmId]: false }))
    }
  }

  const handleUnenroll = async (vmId) => {
    setEnrolling(prev => ({ ...prev, [vmId]: true }))
    setError(null)
    try {
      const token = await getToken()
      const vm = vms.find(v => v.id === vmId)
      const newTags = { ...(vm.tags ?? {}) }
      for (const k of Object.keys(newTags)) {
        if (k.toLowerCase() === 'autoshutdown-enrolled') delete newTags[k]
      }
      await patchVMTags(token, vmId, newTags)
      setVms(prev => prev.map(v => v.id === vmId ? { ...v, tags: newTags } : v))
      setEdits(prev => ({ ...prev, [vmId]: { ...prev[vmId], enrolled: false } }))
    } catch (e) {
      const isAuthz = e.message.includes('403') || e.message.toLowerCase().includes('authorization')
      setError(isAuthz
        ? 'You need Virtual Machine Contributor or Owner role on this VM to unenroll it.'
        : `Failed to unenroll VM: ${e.message}`)
    } finally {
      setEnrolling(prev => ({ ...prev, [vmId]: false }))
    }
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
    const saved  = []
    try {
      const token = await getToken()
      for (const vm of dirtyVMs) {
        const e = edits[vm.id]
        let newTags = { ...(vm.tags ?? {}) }
        for (const key of ['shutdown', 'startup', 'donotshutdown', 'donotstart']) {
          for (const k of Object.keys(newTags)) {
            if (k.toLowerCase() === key) delete newTags[k]
          }
        }
        if (e.shutdown)   newTags.shutdown      = e.shutdown
        if (e.startup)    newTags.startup       = e.startup
        if (e.noShutdown) newTags.donotshutdown = 'true'
        if (e.noStart)    newTags.donotstart    = 'true'
        try {
          await updateVMTags(token, vm.id, newTags)
          saved.push({ vmId: vm.id, newTags })
        } catch (err) {
          const isAuthz = err.message.includes('403') || err.message.toLowerCase().includes('authorization')
          errors.push(isAuthz
            ? `${vm.name}: You need Tag Contributor, Contributor, or Owner to save schedule changes.`
            : `${vm.name}: ${err.message}`)
        }
      }
      if (saved.length > 0) {
        setVms(prev => prev.map(v => {
          const s = saved.find(x => x.vmId === v.id)
          return s ? { ...v, tags: s.newTags } : v
        }))
        setEdits(prev => {
          const next = { ...prev }
          for (const { vmId, newTags } of saved) {
            next[vmId] = {
              shutdown:   getTagCI(newTags, 'shutdown')      ?? '',
              startup:    getTagCI(newTags, 'startup')       ?? '',
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

        <SubscriptionStatus
          status={installStatus}
          onInstall={() => setShowInstallWizard(true)}
          onUninstall={() => setShowUninstall(true)}
        />

        {error && <div className="banner banner-error">{error}</div>}

        {loading && (
          <div className="spinner-wrap"><div className="spinner" /></div>
        )}

        {!loading && vms.length > 0 && (
          <VMTable
            vms={vms}
            edits={edits}
            onEdit={handleEdit}
            isDirty={isDirty}
            onEnroll={handleEnroll}
            onUnenroll={handleUnenroll}
            enrolling={enrolling}
          />
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

      {showInstallWizard && (
        <InstallWizard
          token={cachedToken}
          subId={selectedSubId}
          resourceGroups={resourceGroups}
          onClose={() => setShowInstallWizard(false)}
          onInstalled={() => { setShowInstallWizard(false); refreshInstallStatus() }}
        />
      )}

      {showUninstall && installStatus?.installed && (
        <UninstallDialog
          token={cachedToken}
          subId={selectedSubId}
          installation={installStatus}
          onClose={() => setShowUninstall(false)}
          onUninstalled={() => { setShowUninstall(false); refreshInstallStatus() }}
        />
      )}
    </div>
  )
}
