import { useMsal } from '@azure/msal-react'

export default function Header({ account }) {
  const { instance } = useMsal()

  return (
    <header className="header">
      <div className="header-brand">
        <img src="/powerco-wordmark.png" alt="PowerCo" className="header-wordmark" />
        <div className="header-divider" />
        <span className="header-title">VM Auto-shutdown Manager</span>
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
