// ─── Fill these in after completing the Entra ID App Registration ───────────
// See docs/Setup-Guide.md → Step 1

export const msalConfig = {
  auth: {
    clientId:    '92434e29-142c-45ef-9ac5-18674851afc9',   // App Registration → Overview → Application (client) ID
    authority:   'https://login.microsoftonline.com/a8cf543a-438a-4e26-96a1-a99cfa3c6b07', // Directory (tenant) ID — or use "common"
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

// Scope required to upload blobs to Azure Storage on behalf of the signed-in user
export const storageScopes = ['https://storage.azure.com/user_impersonation']
