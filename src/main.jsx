import React from 'react'
import ReactDOM from 'react-dom/client'
import { PublicClientApplication } from '@azure/msal-browser'
import { MsalProvider } from '@azure/msal-react'
import { msalConfig } from './authConfig'
import App from './App'
import './styles/app.css'

const msalInstance = new PublicClientApplication(msalConfig)

ReactDOM.createRoot(document.getElementById('root')).render(
  <MsalProvider instance={msalInstance}>
    <App />
  </MsalProvider>
)
