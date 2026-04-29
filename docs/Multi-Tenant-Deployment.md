# VM Auto-shutdown Manager — Multi-Tenant Deployment Guide

**PowerCloud Team · v1.0**
**Last updated: 2026-04-29**

---

## Overview

By default the app is configured for a **single tenant** — only users from the specific Azure AD tenant you set in `authConfig.js` can sign in. This guide covers your options if you want to run the solution in a different or additional tenant.

There are two distinct scenarios:

| Scenario | Description |
|---|---|
| **A — Separate instance per tenant** | Deploy a separate copy of the GUI for each tenant. Simplest, most isolated. |
| **B — Multi-tenant app registration** | One deployment that accepts users from any Microsoft tenant. More setup, scales better. |

The **Function App** (AutoShutdown V3) is not affected by either option — it is always deployed per-subscription using the signed-in user's own token, so it works identically regardless of which tenant the user belongs to.

---

## Option A — Separate Instance per Tenant (Recommended)

This is the cleanest approach for internal enterprise use. You run a completely independent deployment for each tenant: its own App Registration, its own Static Web App, its own `authConfig.js`.

### What you change

Only two values in [src/authConfig.js](../src/authConfig.js):

```js
clientId:  'YOUR_NEW_CLIENT_ID',
authority: 'https://login.microsoftonline.com/YOUR_NEW_TENANT_ID',
```

Everything else — the Function App install/uninstall logic, the VM table, the GitHub Actions workflow — stays exactly the same.

### Steps

**1. Create an App Registration in the new tenant**

Follow [Setup-Guide.md → Step 1](Setup-Guide.md) in the new tenant's Azure Portal:
- Supported account types: **Accounts in this organizational directory only**
- Add the new SWA URL as a redirect URI (after Step 3)
- Grant `Azure Service Management → user_impersonation` (delegated)
- Grant admin consent in the new tenant

Copy the **Application (client) ID** and **Directory (tenant) ID**.

**2. Fork or copy the repository**

You can either:
- Create a new GitHub repo from the same source code
- Or use the same repo with a different branch and separate GitHub Actions secret

**3. Update authConfig.js**

```js
clientId:  '<Application (client) ID from new tenant>',
authority: 'https://login.microsoftonline.com/<Directory (tenant) ID of new tenant>',
```

**4. Create a new Azure Static Web App**

Follow [Setup-Guide.md → Steps 3–4](Setup-Guide.md) in the new tenant's Azure subscription.
Add its URL as a redirect URI in the new App Registration.

**5. Push and deploy**

```bash
git add src/authConfig.js
git commit -m "Configure for new tenant"
git push
```

GitHub Actions builds and deploys. Users in the new tenant can now sign in.

---

## Option B — Multi-Tenant App Registration

This turns the app into a platform that accepts sign-ins from **any** Microsoft organizational tenant. Any user who has access to an Azure subscription can sign in and manage VMs in that subscription — no per-tenant setup needed.

### How it works

When a user signs in:
- MSAL authenticates them against their own home tenant
- The ARM access token is issued for **their** subscriptions
- The app lists only subscriptions that user has access to
- The Function App install deploys into whatever subscription they select

Each user only ever sees and touches their own subscriptions. There is no cross-tenant data leakage.

### What you change

**1. Update the App Registration**

In Azure Portal → Entra ID → App registrations → your app → **Authentication**:
- Under **Supported account types**, change to:
  **Accounts in any organizational directory (Any Microsoft Entra ID tenant — Multitenant)**
- Save

**2. Update authConfig.js**

Change the `authority` from your specific tenant to the common endpoint:

```js
export const msalConfig = {
  auth: {
    clientId:  '605c559a-cae2-4109-9609-26bd9e14b052',   // same — your app registration
    authority: 'https://login.microsoftonline.com/organizations',  // ← change this line
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: 'sessionStorage',
    storeAuthStateInCookie: false,
  },
}
```

Use `organizations` (not `common`) to restrict to organizational accounts only and exclude personal Microsoft accounts.

**3. Push and deploy**

```bash
git add src/authConfig.js
git commit -m "Switch to multi-tenant (organizations) authority"
git push
```

### Considerations for multi-tenant

| Topic | Detail |
|---|---|
| **Admin consent** | The `user_impersonation` scope for Azure Service Management is a delegated permission that does not require admin consent in most tenants. Users can consent themselves on first sign-in. |
| **Who can sign in** | Any user with an Entra ID (Microsoft 365) organizational account. Personal Microsoft accounts (@outlook.com, @hotmail.com) are excluded by `organizations`. |
| **Data isolation** | Each user only sees their own subscriptions. No user can see another user's data. |
| **App visibility** | The app becomes publicly usable by any org. If you want to restrict it, use Conditional Access on the App Registration or keep Option A. |
| **Token audience** | ARM tokens are always scoped to `https://management.azure.com/` — they work identically regardless of the user's home tenant. |

---

## Cross-Tenant Subscription Access

This is a different scenario: a user in **Tenant A** needs to manage VMs in a subscription that belongs to **Tenant B**.

This is not a GUI configuration change — it is an Azure RBAC problem. The user needs to be granted access to that subscription directly. Options:

**Option 1 — B2B Guest invite (most common)**

Invite the Tenant A user as a guest in Tenant B:
1. In Tenant B's Azure Portal → Entra ID → External Identities → Invite user
2. Enter the user's Tenant A email address
3. Once accepted, assign the user the appropriate RBAC role on the subscription in Tenant B
4. The user signs into the app using their Tenant A credentials
5. They will see both Tenant A and Tenant B subscriptions in the subscription dropdown

> This works because ARM checks RBAC, not the user's home tenant. A guest user with Contributor access on a subscription can read and modify resources there.

**Option 2 — Lighthouse (for MSP / multi-customer scenarios)**

Azure Lighthouse allows a service provider tenant to manage customer subscriptions without needing guest accounts. This is outside the scope of this tool, but if Lighthouse delegated access is configured, the Function App can be installed into the delegated subscription using the provider user's credentials.

---

## Summary

| | Option A (separate instance) | Option B (multi-tenant) |
|---|---|---|
| **Setup effort** | Medium — one App Registration per tenant | Low — one App Registration total |
| **Maintenance** | One deployment per tenant | One deployment for all |
| **Access control** | Tight — only one tenant per instance | Loose — any org can use it |
| **Recommended for** | Internal enterprise, controlled rollout | Cross-org platforms, MSP use |
| **Function App** | Unchanged — works the same | Unchanged — works the same |
| **Changes required** | New App Registration + new SWA + new authConfig | Authority `→ organizations` + App Registration setting |

---

*PowerCloud Team · VM Auto-shutdown Manager · Multi-Tenant Deployment Guide · v1.0*
