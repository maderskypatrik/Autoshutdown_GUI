# VM Auto-shutdown Manager — Setting Up for a Different Tenant

**PowerCloud Team · v1.0**
**Last updated: 2026-04-29**

---

## Overview

The app is bound to a specific Azure AD tenant via two values in `authConfig.js`. To run the app for a different tenant, you repeat the original setup in that tenant and swap those two values.

**Time required:** ~20 minutes

---

## What you need

- Admin access (or a contact with admin access) in the target tenant to create the App Registration
- An Azure subscription in the target tenant to host the Static Web App
- Access to the GitHub repository to update the config and add a secret

---

## Steps

### Step 1 — Create an App Registration in the new tenant

Log into the **Azure Portal for the new tenant** and follow the same steps as the original setup:

1. Go to **Entra ID** → **App registrations** → **+ New registration**
2. Fill in:
   - **Name:** `VM Auto-shutdown Manager` (or any name)
   - **Supported account types:** Accounts in this organizational directory only
   - **Redirect URI:** Single-page application → `http://localhost:5173`
3. Click **Register**
4. Copy the **Application (client) ID** and **Directory (tenant) ID** from the Overview page
5. Go to **API permissions** → **+ Add a permission** → **Azure Service Management** → **user_impersonation** → Add
6. Click **Grant admin consent for [tenant]** → Confirm

---

### Step 2 — Update authConfig.js

Open [src/authConfig.js](../src/authConfig.js) and replace the two values:

```js
clientId:  '<Application (client) ID from new tenant>',
authority: 'https://login.microsoftonline.com/<Directory (tenant) ID from new tenant>',
```

---

### Step 3 — Create a new Static Web App

In an Azure subscription in the new tenant:

1. Go to **Azure Portal** → **Static Web Apps** → **+ Create**
2. Connect it to the same GitHub repository (or a fork), branch `main`
3. Build details: App location `/`, Output location `dist`
4. After creation, copy the **URL** (e.g. `https://random-name.azurestaticapps.net`)

---

### Step 4 — Add the SWA URL to the App Registration

1. Go back to the App Registration in the new tenant → **Authentication**
2. Under **Single-page application** → **+ Add URI**
3. Paste the SWA URL from Step 3
4. Click **Save**

---

### Step 5 — Add the deployment token to GitHub

1. In the new Static Web App → **Manage deployment token** → Copy the token
2. Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions**
3. Add a new secret (use a different name if you already have one, e.g. `AZURE_STATIC_WEB_APPS_API_TOKEN_TENANT2`)
4. Update the workflow file `.github/workflows/azure-static-web-apps.yml` to use the new secret name

---

### Step 6 — Push and deploy

```bash
git add src/authConfig.js
git commit -m "Configure for new tenant"
git push
```

GitHub Actions builds and deploys. Users in the new tenant can now sign in and use the app.

---

## Running for multiple tenants simultaneously

Because `authConfig.js` is baked into the build, one deployed instance = one tenant. To serve multiple tenants at the same time:

- Use **separate branches** in the same repo, each with its own `authConfig.js` and GitHub Actions workflow pointing to its own SWA and secret
- Or use **separate forked repositories**, one per tenant

The Function App (AutoShutdown V3) is not affected by any of this — it always deploys per-subscription using the signed-in user's own token, regardless of which tenant they belong to.

---

*PowerCloud Team · VM Auto-shutdown Manager · New Tenant Setup · v1.0*
