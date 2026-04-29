import { useMsal } from '@azure/msal-react'

export default function Header({ account }) {
  const { instance } = useMsal()

  return (
    <header className="header">
      <div className="header-title">
        <span className="header-icon">&#9729;</span>
        VM Auto-shutdown Manager
      </div>
      <div className="header-user">
        <span className="header-username">{account?.username}</span>
        <button
          className="btn btn-ghost"
          onClick={() => instance.logoutPopup()}
        >
          Sign out
        </button>
      </div>
    </header>
  )
}
