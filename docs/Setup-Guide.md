# VM Auto-shutdown Manager — Setup Guide

**PowerCloud Team · v1.1**
**Last updated: 2026-05-06**

---

## Overview

This guide walks you through the full setup from zero to a running web app. The app lets users log in with their Microsoft account, browse their Azure VMs, and set shutdown/startup schedules — directly from the browser with no backend or secrets required.

**What you will set up:**

1. Entra ID App Registration (so users can sign in and call Azure APIs)
2. GitHub repository (to host and deploy the code)
3. Azure Static Web App (to host the frontend)
4. GitHub secret (to connect GitHub Actions to Azure)
5. `authConfig.js` (two values to fill in from Step 1)

**Time required:** ~30 minutes

---

## Prerequisites

- An Azure subscription (to create the Static Web App)
- A GitHub account
- Node.js 18 or later installed locally (`node -v` to check)
- Azure CLI or access to the Azure Portal

---

## Step 1 — Create the Entra ID App Registration

This registers the app with Azure AD so users can sign in and the app can call Azure management APIs on their behalf.

### 1.1 Open App Registrations

1. Go to the **Azure Portal** → search for **Entra ID** → click **App registrations**
2. Click **+ New registration**

### 1.2 Fill in the registration form

| Field | Value |
|---|---|
| **Name** | `VM Auto-shutdown Manager` (or any name you like) |
| **Supported account types** | **Accounts in this organizational directory only** (single tenant) |
| **Redirect URI** | Select **Single-page application (SPA)** → enter `http://localhost:5173` |

Click **Register**.

### 1.3 Note down the IDs you need

On the **Overview** page, copy:
- **Application (client) ID** → this is `YOUR_CLIENT_ID`
- **Directory (tenant) ID** → this is `YOUR_TENANT_ID`

Keep these — you will paste them into `src/authConfig.js` in Step 5.

### 1.4 Add API permissions

1. In the left menu, click **API permissions**
2. Click **+ Add a permission**
3. Click **Azure Service Management**
4. Select **Delegated permissions** → tick **user_impersonation**
5. Click **Add permissions**
6. Click **Grant admin consent for [your tenant]** → confirm

> **Why this permission?**  
> `user_impersonation` allows the app to call Azure Management APIs (list subscriptions, resource groups, VMs, update tags) on behalf of the signed-in user. The user's own Azure RBAC permissions are enforced — they can only see and modify what they already have access to.

### 1.5 Add the production redirect URI

You will add the Static Web App URL here after Step 3. Leave this tab open or come back to it.

---

## Step 2 — Set up the GitHub repository

### 2.1 Create a new GitHub repo

1. Go to [github.com](https://github.com) → **New repository**
2. Name it: `Autoshutdown_GUI` (or any name)
3. Set it to **Private** (recommended)
4. Do **not** initialise with a README (the code folder already has files)
5. Click **Create repository**

### 2.2 Push the code

Open a terminal in the project folder (`Autoshutdown_GUI`) and run:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/Autoshutdown_GUI.git
git push -u origin main
```

---

## Step 3 — Create the Azure Static Web App

Azure Static Web Apps hosts the frontend and auto-generates a GitHub Actions deployment workflow.

### 3.1 Create the resource

1. Go to the **Azure Portal** → search for **Static Web Apps** → click **+ Create**
2. Fill in the form:

| Field | Value |
|---|---|
| **Subscription** | Your subscription |
| **Resource Group** | Create new: `rg-autoshutdown-gui` (or use an existing one) |
| **Name** | `swa-autoshutdown-gui` (globally unique) |
| **Plan type** | **Free** |
| **Region** | Any — pick the closest to you |
| **Source** | **GitHub** |

3. Click **Sign in with GitHub** and authorise Azure

4. Set:
   - **Organisation** → your GitHub account
   - **Repository** → `Autoshutdown_GUI`
   - **Branch** → `main`

5. **Build Details:**
   - **Build Presets** → `React`
   - **App location** → `/`
   - **Output location** → `dist`

6. Click **Review + Create** → **Create**

### 3.2 Get the deployment token

1. Once the resource is created, open it in the Azure Portal
2. In the left menu, click **Manage deployment token**
3. Copy the token value — you will need it in Step 4

### 3.3 Note the SWA URL

On the **Overview** page, copy the **URL** (looks like `https://random-name.azurestaticapps.net`). You need this for Step 1.5.

### 3.4 Add the SWA URL to the App Registration (Step 1.5)

1. Go back to **Entra ID** → **App registrations** → your app
2. In the left menu, click **Authentication**
3. Under **Single-page application**, click **+ Add URI**
4. Paste the SWA URL (e.g. `https://random-name.azurestaticapps.net`)
5. Click **Save**

---

## Step 4 — Add the deployment secret to GitHub

The GitHub Actions workflow needs this token to deploy to Azure.

1. Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Name: `AZURE_STATIC_WEB_APPS_API_TOKEN`
4. Value: paste the token from Step 3.2
5. Click **Add secret**

---

## Step 5 — Configure authConfig.js

Open [src/authConfig.js](../src/authConfig.js) and replace the two placeholder values:

```js
clientId:  'YOUR_CLIENT_ID',    // → paste Application (client) ID from Step 1.3
authority: 'https://login.microsoftonline.com/YOUR_TENANT_ID',  // → paste Directory (tenant) ID
```

**Example:**
```js
clientId:  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
authority: 'https://login.microsoftonline.com/11223344-5566-7788-99aa-bbccddeeff00',
```

Save the file, commit, and push:

```bash
git add src/authConfig.js
git commit -m "Configure Entra ID client ID and tenant"
git push
```

GitHub Actions will automatically build and deploy. Check the **Actions** tab in GitHub to watch the deployment.

---

## Step 6 — Test locally (optional but recommended)

Before relying on the deployed version, test locally:

```bash
cd Autoshutdown_GUI
npm install
npm run dev
```

Open `http://localhost:5173` in your browser. You should see the login screen.

Click **Sign in with Microsoft** — you are redirected to the Microsoft login page and back. After signing in:
- The subscription dropdown populates
- Select a subscription → Resource Groups load
- Select a Resource Group (or leave as "All") → click **Load VMs**
- VMs appear in the table with their current shutdown/startup tag values

---

## Step 7 — Verify deployment

1. Go to your GitHub repo → **Actions** tab
2. You should see a workflow run triggered by your last push
3. Once it passes (green checkmark), open the SWA URL
4. Sign in and verify the app works

---

## How the app works

| Action | What happens |
|---|---|
| Sign in | MSAL.js authenticates with Entra ID and gets an ARM access token |
| Load VMs | App calls Azure Resource Graph API with the user's token — returns all VM names, RGs, current tags, and power state |
| Edit time | User types a time in `HH:mm` format — change is tracked locally, not saved yet |
| Check "Exclude" | Marks the VM for `donotshutdown`/`donotstart` tag — tracked locally |
| Save Changes | For each modified VM, app calls the Azure VM PATCH API to update the tag set. If a shutdown or startup time is set, `autoshutdown-enrolled` is added automatically. If both times are cleared, it is removed. |
| Function App | Every 15 minutes, queries Resource Graph for VMs that have **both** `autoshutdown-enrolled` and `shutdown`/`startup` tags, then acts only on those in the current time window |
| Self-update | On every invocation, each Function App compares its running version against `version.json` on the SWA. If a newer version is available it restarts itself using its own Managed Identity, forcing Azure to download the new zip. No central credential required. |
| Return later | App always reads current tag values from Azure — it is stateless |

Times are in **local time** as configured by the `TIMEZONE` app setting of the Function App (default: `Central European Standard Time`).

### VM enrollment security model

The `autoshutdown-enrolled` tag acts as an explicit allowlist gate at the Function App level. The UI manages it automatically — it is added when a schedule is saved and removed when both times are cleared. A VM with a `shutdown` tag but without `autoshutdown-enrolled` is completely ignored by the Function App.

All tag writes go through the Azure VM PATCH API (`Microsoft.Compute/virtualMachines/write`), which Azure enforces server-side. Users with Tag Contributor role receive a 403 and cannot modify any VM schedules.

---

## Covering multiple subscriptions

The Function App is installed once but can manage VMs across any number of subscriptions without reinstalling. For each additional subscription you want covered:

1. Go to **Azure Portal** → the target subscription → **Access control (IAM)**
2. Click **+ Add** → **Add role assignment**
3. Assign **Reader** to the Managed Identity (`mi-autoshutdown` or as tagged on the Function App)
4. Repeat for **Virtual Machine Contributor**

The Function App uses Azure Resource Graph to discover all tagged VMs across every subscription its Managed Identity can access, so the new subscription is picked up automatically on the next run.

To find the Managed Identity name: open the Function App in the portal → **Tags** → copy the value of `autoshutdown-mi-principal-id`, then look it up under **Entra ID** → **Managed identities**.

---

## Required permissions for users

| What the user wants to do | Minimum required role |
|---|---|
| Sign in and view VMs | **Reader** on the subscription or resource group |
| Set or change shutdown / startup times | **Owner**, **Contributor**, or **Virtual Machine Contributor** on the subscription, resource group, or VM |
| Exclude a VM from shutdown or startup | Same as above |
| Install the AutoShutdown solution | **Owner** on the subscription |

Users with only Reader access can see VMs and their current power state but cannot make any changes.

All write operations go through the Azure VM PATCH API, which enforces `Microsoft.Compute/virtualMachines/write`. Tag Contributor alone is not sufficient — users with only Tag Contributor will receive a permission error when attempting to save.

---

## Troubleshooting

### "AADSTS50011: The redirect URI does not match"

The `redirectUri` in `authConfig.js` must exactly match a URI registered in the App Registration → Authentication.

- For local dev: `http://localhost:5173` must be listed
- For production: the SWA URL must be listed

### "Failed to load subscriptions: HTTP 403"

The signed-in user has no Reader access on any subscription. Ask a subscription Owner to assign the user at least **Reader** role.

### Save Changes fails with a permission error

The user can read VMs but cannot write tags. Ask a subscription admin to assign **Owner**, **Contributor**, or **Virtual Machine Contributor** on the relevant subscription, resource group, or VM. Tag Contributor is not sufficient.

### GitHub Actions deployment fails

- Check that the `AZURE_STATIC_WEB_APPS_API_TOKEN` secret is set correctly in GitHub → Settings → Secrets
- Check the Actions log for the specific error message

### App loads but sign-in does not complete

The app uses redirect-based login (no popup). If the sign-in loop repeats without completing, check that the redirect URI is registered correctly in the App Registration → Authentication (see Step 1.5).

---

## Releasing a new version

### GUI changes (frontend only)

Any push to `main` redeploys the SWA automatically via GitHub Actions — no manual steps needed.

```bash
git add .
git commit -m "your change"
git push
```

### Function App changes (PowerShell scripts)

1. Make your changes to the scripts under `public/function-app/`
2. Bump the version in `package.json` (e.g. `"version": "1.1.0"`)
3. Commit and push to `main`

GitHub Actions will write the new version into `version.txt` (baked into the zip) and `version.json` (served by the SWA). Within one 15-minute timer cycle, every installed Function App detects the mismatch, restarts itself, and downloads the new zip automatically.

No access to individual subscriptions is required. The update happens independently in each subscription using only that subscription's own Managed Identity.

---

## See also

- [Multi-Tenant-Deployment.md](Multi-Tenant-Deployment.md) — deploying for a different or additional Azure AD tenant
- [User-Guide.md](User-Guide.md) — end-user guide for navigating the app and setting schedules

---

*PowerCloud Team · VM Auto-shutdown Manager · Setup Guide · v1.0*
