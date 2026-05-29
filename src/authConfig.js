// ─── Fill these in after completing the Entra ID App Registration ───────────
// See docs/Setup-Guide.md → Step 1

export const msalConfig = {
  auth: {
    clientId:    '605c559a-cae2-4109-9609-26bd9e14b052',   // App Registration → Overview → Application (client) ID
    authority:   'https://login.microsoftonline.com/0e7cee5a-a076-4664-b59d-a617348d5541', // Directory (tenant) ID — or use "common"
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
