import React from 'react'
import ReactDOM from 'react-dom/client'
import { PublicClientApplication } from '@azure/msal-browser'
import { MsalProvider } from '@azure/msal-react'
import { msalConfig } from './authConfig'
import App from './App'
import './styles/app.css'

const msalInstance = new PublicClientApplication(msalConfig)

// MSAL browser v3 requires initialize() to complete before rendering
msalInstance.initialize().then(() => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <MsalProvider instance={msalInstance}>
      <App />
    </MsalProvider>
  )
}).catch(err => {
  document.getElementById('root').innerHTML =
    `<div style="padding:40px;font-family:sans-serif;color:#c42b1c">
      <strong>MSAL initialization failed:</strong> ${err.message}
    </div>`
})
