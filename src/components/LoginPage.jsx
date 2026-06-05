import { useMsal } from '@azure/msal-react'
import { armScopes } from '../authConfig'

export default function LoginPage() {
  const { instance } = useMsal()

  const handleLogin = () => {
    instance.loginRedirect({ scopes: armScopes }).catch(console.error)
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-logo">
          <img src="/powerco-wordmark.png" alt="PowerCo" className="login-logo-img" />
        </div>
        <h1>VM Scheduler</h1>
        <p>
          Manage daily shutdown and startup schedules for your Azure VMs.<br />
          Set times per VM using Azure tags — directly from the browser,
          no backend required.
        </p>
        <button className="btn btn-signin" onClick={handleLogin}>
          Sign in with Microsoft
        </button>
        <p className="login-note">
          You will be asked to consent to read and manage Azure resources
          on behalf of your account.
        </p>
      </div>
    </div>
  )
}
