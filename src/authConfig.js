// ─── Fill these in after completing the Entra ID App Registration ───────────
// See docs/Setup-Guide.md → Step 1

export const msalConfig = {
  auth: {
    clientId:    'YOUR_CLIENT_ID',   // App Registration → Overview → Application (client) ID
    authority:   'https://login.microsoftonline.com/YOUR_TENANT_ID', // Directory (tenant) ID — or use "common"
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: 'sessionStorage',
    storeAuthStateInCookie: false,
  },
}

// Scope required to call Azure ARM REST APIs on behalf of the signed-in user
export const armScopes = ['https://management.azure.com/user_impersonation']
