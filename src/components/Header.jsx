import { useMsal } from '@azure/msal-react'

export default function Header({ account }) {
  const { instance } = useMsal()

  return (
    <header className="header">
      <div className="header-brand">
        <a
          href="https://cloud.powerco.tech"
          className="header-logo-link"
          title="Back to Cloud Portfolio"
          aria-label="Back to Cloud Portfolio"
        >
          <img src="/brand_dark.svg" alt="PowerCo" className="header-logo-icon" />
        </a>
        <div className="header-divider" />
        <span className="header-title">VM Scheduler</span>
      </div>
      <div className="header-user">
        <span className="header-username">{account?.username}</span>
        <button
          className="btn btn-ghost"
          onClick={() => instance.logoutRedirect()}
        >
          Sign out
        </button>
      </div>
    </header>
  )
}
