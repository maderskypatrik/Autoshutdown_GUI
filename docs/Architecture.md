# VM Auto-shutdown Manager — Architecture

**PowerCloud Team · Last updated: 2026-06-02**

---

## System Overview

The solution has two independent layers that share data only through Azure VM tags, plus a lightweight server-side API function for Confluence tracking.

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser (React SPA)                                             │
│  User authenticates via Entra ID → gets ARM access token         │
│  Calls Azure ARM APIs directly with the user's own token         │
│  Reads / writes VM tags                                          │
└──────────┬───────────────────────────────────┬───────────────────┘
           │ ARM API (user's token)             │ POST /api/confluence
           ▼                                   ▼
┌─────────────────────────┐   ┌────────────────────────────────────┐
│  Azure Resource Manager │   │  SWA API Function (server-side)    │
│  Resource Graph          │   │  Reads Confluence credentials from │
│  ARM statusOnly          │   │  SWA app settings (never in        │
│  VM PATCH API            │   │  browser). Adds/removes rows in    │
└────────────┬────────────┘   │  the Deployed Subscriptions page.  │
             │ VM tags         └────────────────────────────────────┘
             ▼
┌──────────────────────────────────────────────────────────────────┐
│  Azure Automation Account  (PowerShell 7.2 runbooks)             │
│  Runs every 15 minutes — reads tags via Resource Graph REST API  │
│  Shuts down / starts up VMs independently of the browser         │
│  System-assigned managed identity — scoped to own subscription   │
└──────────────────────────────────────────────────────────────────┘
```

There is no database, no storage account, and no shared secrets in the browser. The Confluence token lives only in SWA application settings and is only ever accessed server-side.

---

## Frontend

### Hosting

React SPA built with Vite, deployed to **Azure Static Web Apps** via GitHub Actions.

The runbook PowerShell scripts (`public/runbooks/AutoShutdown.ps1`, `public/runbooks/AutoStartup.ps1`) are bundled directly into the JavaScript bundle at build time via Vite `?raw` imports in `deploy.js`. The installer uploads their content to the Automation Account via the ARM draft/content API (`PUT .../runbooks/{name}/draft/content`) — no public URL fetch is needed.

The SWA also hosts the **API function** (`api/confluence/`) which handles Confluence tracking server-side.

### Authentication

MSAL.js (`@azure/msal-react`) handles authentication against Entra ID. After sign-in, MSAL provides an ARM access token (`https://management.azure.com/user_impersonation`) which is passed as a Bearer token on every API call. Azure enforces the signed-in user's own RBAC permissions — the app has no elevated access of its own.

### Component map

```
src/
├── main.jsx                   Entry point — wraps app in MsalProvider
├── authConfig.js              MSAL config: clientId, tenantId, redirectUri, scopes
├── App.jsx                    Root component — all state, all orchestration logic
├── components/
│   ├── LoginPage.jsx          Unauthenticated landing page with Sign-in button
│   ├── Header.jsx             Top bar: app title + signed-in username + sign-out
│   ├── Controls.jsx           Subscription dropdown, Resource Group dropdown, Load VMs button
│   ├── SubscriptionStatus.jsx Install status bar (checking / not installed / installed / update available)
│   ├── VMTable.jsx            VM list with schedule editors and power state
│   ├── InstallWizard.jsx      Multi-step modal to deploy Automation Account into a subscription
│   ├── UninstallDialog.jsx    Confirmation modal to remove all AutoShutdown resources
│   └── UpdateDialog.jsx       Modal to re-publish runbooks without removing any resources
└── services/
    ├── azure.js               ARM read/write calls (subscriptions, RGs, VMs, tags, power state refresh)
    └── deploy.js              Install, update, uninstall, and detectInstallation logic

api/
├── confluence/
│   ├── index.js               SWA API function — receives action (add/remove), updates Confluence page
│   └── function.json          HTTP trigger, POST, anonymous authLevel
└── package.json               Node 18 engine specification

public/
└── runbooks/
    ├── AutoShutdown.ps1       PowerShell 7.2 runbook — bundled via Vite ?raw at build time
    └── AutoStartup.ps1        PowerShell 7.2 runbook — bundled via Vite ?raw at build time
```

### State management (`App.jsx`)

All application state lives in `App.jsx`. No external state library. Key state:

| State | Purpose |
|---|---|
| `subscriptions` | List of subscriptions the user has access to |
| `selectedSubId` | Currently selected subscription |
| `resourceGroups` | RGs in the selected subscription |
| `selectedRg` | Currently selected RG (empty = all) |
| `vms` | VM list (tags from Resource Graph, power state from ARM statusOnly) |
| `edits` | Map of `vmId → { shutdown, startup, noShutdown, noStart }` — local unsaved changes |
| `installStatus` | `null / 'checking' / { installed: false } / { installed: true, ...details }` |

`edits` is initialised from `vms` when VMs load and re-synced after a successful save. A 30-second interval updates only `powerState` on each VM while the table is visible, without touching tags or edits.

---

## Services Layer

### `src/services/azure.js`

All direct ARM API calls. Uses the user's token — Azure enforces their RBAC.

| Function | API | Notes |
|---|---|---|
| `getSubscriptions` | `GET /subscriptions` | Lists all subscriptions the user has Reader on |
| `getResourceGroups` | `GET /subscriptions/{sub}/resourcegroups` | Lists RGs in a subscription |
| `getVMs` | Resource Graph POST + ARM statusOnly GET | Phase 1: tags and metadata; Phase 2: real-time power state |
| `refreshVMPowerStates` | `GET …/virtualMachines?statusOnly=true` | Lightweight poll — only power state, no tags |
| `patchVMTags` | `PATCH {vmId}?api-version=2024-03-01` | Requires `Microsoft.Compute/virtualMachines/write` |

`getVMs` uses two separate calls because Resource Graph caches power state and can lag by several minutes. The ARM `statusOnly=true` endpoint returns real-time data and is used for both initial load and the 30-second background refresh.

### `src/services/deploy.js`

Handles installation lifecycle. Uses the user's token — requires Owner on the subscription.

| Function | What it does |
|---|---|
| `detectInstallation` | Resource Graph query for an `microsoft.automation/automationaccounts` resource tagged `autoshutdown-managed=v4-automation` |
| `installAutoShutdown` | Creates Automation Account (system-assigned MI) → assigns RBAC → fetches and publishes runbooks → creates schedules and links them |
| `updateRunbooks` | Re-fetches runbooks from SWA origin, re-publishes both, stamps new `autoshutdown-version` tag on the account |
| `uninstallAutoShutdown` | Removes RBAC role assignments, then deletes the Automation Account (system-assigned MI is deleted automatically) |

`RUNBOOK_VERSION` is exported from `deploy.js` and compared against the `autoshutdown-version` tag on the installed account. When they differ, `SubscriptionStatus` shows an amber **"Update available"** button.

### `api/confluence/index.js` — SWA API Function

Server-side Azure Function (Node.js 18) that keeps a Confluence page up to date with the list of subscriptions where the solution is installed. Called automatically on install and uninstall — never from the browser with credentials.

**Trigger:** `POST /api/confluence`

**Body:**
```json
{ "action": "add" | "remove", "subscriptionId": "...", "subscriptionName": "...", "automationAccountName": "...", "installedBy": "..." }
```

**Behaviour:**
- `add`: removes any existing row for the subscriptionId (idempotent dedup), then appends a new row with subscription name, ID, install date, installed-by, and Automation Account name
- `remove`: removes the row matching the subscriptionId

**Credentials** are read from SWA Application Settings (environment variables), never from the request body:

| Setting | Purpose |
|---|---|
| `CONFLUENCE_BASE_URL` | Base URL of the Confluence instance (e.g. `https://yourcompany.atlassian.net/wiki`) |
| `CONFLUENCE_PAGE_ID` | Numeric ID of the target Confluence page |
| `CONFLUENCE_TOKEN` | Personal Access Token (PAT) with write access to the page |

Confluence calls fail silently — a Confluence outage or misconfiguration does not block install or uninstall.

---

## Tag Schema

### VM scheduling tags

All scheduling data is stored as Azure tags on the VM. No other data store.

| Tag | Value format | Purpose |
|---|---|---|
| `shutdown` | `HH:mm` (e.g. `18:30`) | Daily shutdown time in configured timezone |
| `startup` | `HH:mm` (e.g. `07:00`) | Daily startup time in configured timezone |
| `autoshutdown-enrolled` | any (e.g. `true`) | Marks VM as managed — runbooks ignore VMs without this tag |
| `donotshutdown` | any | Prevents automatic shutdown regardless of `shutdown` tag |
| `donotstart` | any | Prevents automatic startup regardless of `startup` tag |

**Implicit enrollment:** The UI sets `autoshutdown-enrolled` automatically when a schedule is saved (if either `shutdown` or `startup` is set) and removes it when both are cleared.

### Tags on managed infrastructure resources

| Tag | Set on | Value | Purpose |
|---|---|---|---|
| `autoshutdown-managed` | Automation Account | `v4-automation` | Identifies resources owned by this solution (used by uninstall and detectInstallation) |
| `autoshutdown-version` | Automation Account | Date string e.g. `20260601` | Runbook version stamp — compared against app constant to show update prompt |

---

## Automation Account

### Infrastructure

- **Runtime:** PowerShell 7.2 (built-in Az.Accounts and Az.Compute — no module imports required)
- **Schedule:** every 15 minutes, aligned to clock boundaries (`:00`, `:15`, `:30`, `:45`)
- **Identity:** System-assigned managed identity — Reader + VM Contributor (subscription scope), Automation Contributor (resource group scope)
- **Monitoring:** Azure Automation Jobs — every execution is logged under the Automation Account → Jobs in the Azure Portal
- **Subscription scope:** one Automation Account per subscription; runbooks query Resource Graph scoped to their own subscription only

### Runbooks

#### `AutoShutdown` — every 15 minutes

1. Acquires ARM token via system-assigned managed identity (`Connect-AzAccount -Identity`)
2. Queries Resource Graph via `Invoke-RestMethod` for all VMs with both `shutdown` and `autoshutdown-enrolled` tags in the subscription
3. Filters to VMs whose `shutdown` time falls within the current 15-minute window
4. Skips VMs tagged `donotshutdown`
5. Skips VMs already deallocated / powered off
6. Deallocates Azure VMs (REST `POST .../deallocate`) or stops Azure Local VMs (REST `POST .../stop`) in parallel (`ForEach-Object -Parallel`, throttle 20)

#### `AutoStartup` — every 15 minutes

Same structure as AutoShutdown but in reverse:

1. Queries Resource Graph for VMs with `startup` + `autoshutdown-enrolled`
2. Filters to current 15-minute window
3. Skips VMs tagged `donotstart`
4. Skips VMs already running
5. Starts Azure VMs (REST `POST .../start`) or Azure Local VMs (REST `POST .../start`) in parallel

### Time window logic (`Test-InWindow`)

```
Target time: e.g. 18:30
Current time window: 18:29:30 → 18:44:59  (15 min window, 30s early buffer)

$Now >= $target.AddSeconds(-30)   ← 30s buffer for scheduler early-fire jitter
$Now <  $target.AddMinutes(15)    ← window end
```

### VM type handling

| VM type | Resource Graph type | Stop | Start | Already-off check |
|---|---|---|---|---|
| Azure VM | `microsoft.compute/virtualmachines` | REST `POST .../deallocate` | REST `POST .../start` | `powerState == 'VM deallocated'` |
| Azure Local (HCI) | `microsoft.azurestackhci/virtualmachineinstances` | REST `POST .../stop` | REST `POST .../start` | `powerState == 'Off' or 'Stopped'` |

### Resource Graph — why REST instead of Search-AzGraph

The PS 7.2 sandbox has a built-in version of Az.Accounts that conflicts with the Az.ResourceGraph module's assembly loader. Installing Az.ResourceGraph into the PS 7.2 module store causes an `AzAssemblyLoadContextInitializer` error at runtime.

**Fix:** both runbooks call the Resource Graph REST endpoint directly via `Invoke-RestMethod` with the managed identity ARM token. This requires no module imports and is more reliable.

---

## Data Flows

### 1. User loads VMs

```
User selects subscription
  → detectInstallation (Resource Graph: find automation/automationaccounts tagged v4-automation)
  → getResourceGroups (ARM list RGs)
User clicks Load VMs
  → getVMs:
     Phase 1: Resource Graph query — id, name, resourceGroup, tags, location
     Phase 2: ARM /virtualMachines?statusOnly=true — real-time powerState
  → App initialises edits map from current tag values
  → VMTable renders
  → 30s interval starts to refresh powerState in background
```

### 2. User saves a schedule

```
User types 18:30 in Shutdown field
  → edit state updated locally (not saved)
  → footer shows "1 VM with unsaved changes"
User clicks Save Changes
  → For each dirty VM:
     1. Build new tag set from edit state
     2. If shutdown or startup is set → add autoshutdown-enrolled: true
     3. If both cleared → remove autoshutdown-enrolled
     4. PATCH {vmId}?api-version=2024-03-01 with new tag set
        Azure enforces: requires Microsoft.Compute/virtualMachines/write
        Tag Contributor → 403 → friendly error shown
  → On success: vms and edits state updated to reflect saved tags
```

### 3. Automation runs (every 15 min)

```
Schedule fires
  → Connect-AzAccount -Identity (system-assigned MI)
  → Get-AzAccessToken → call Resource Graph REST endpoint
  → Find all VMs with shutdown/startup + autoshutdown-enrolled in this subscription
  → For each VM in window (ForEach-Object -Parallel, throttle 20):
     - Skip if donotshutdown / donotstart
     - Skip if already in desired power state
     - Act: REST deallocate or start (fire-and-forget, 202 Accepted)
  → Print summary to job output
```

### 4. Confluence tracking (install / uninstall)

```
installAutoShutdown or uninstallAutoShutdown completes
  → deploy.js POSTs to /api/confluence (fire-and-forget, catch ignored)
     Body: { action: 'add'|'remove', subscriptionId, subscriptionName, automationAccountName, installedBy }
  → SWA routes request to api/confluence/index.js (server-side, Node 18)
  → Function reads CONFLUENCE_BASE_URL, CONFLUENCE_PAGE_ID, CONFLUENCE_TOKEN from SWA app settings
  → GET Confluence page body (REST API v2)
  → 'add': removeRow(body, subscriptionId) then appendRow(body, row data)
     'remove': removeRow(body, subscriptionId)
  → PUT updated page body back to Confluence with incremented version number
```

### 5. Runbook update

```
Admin pushes runbook code change to GitHub → bumps RUNBOOK_VERSION in deploy.js
  → SWA redeploys automatically (GitHub Actions)
  → /runbooks/AutoShutdown.ps1 and AutoStartup.ps1 updated on SWA
User opens app
  → detectInstallation returns installed version tag
  → SubscriptionStatus: autoshutdown-version tag != RUNBOOK_VERSION → "Update available" shown
User clicks "Update available"
  → updateRunbooks: fetches new PS1 files from SWA, PUT + publish to Automation Account
  → PATCH Automation Account tags with new RUNBOOK_VERSION
  → Button disappears; no downtime, no RBAC or schedule changes
```

---

## Installer Flow (`installAutoShutdown`)

Runs entirely in the browser using the user's token (must be Owner on subscription).

```
1. Read resource group location (determines Azure region)
2. Create Automation Account
   └── identity: SystemAssigned
   └── tags: autoshutdown-managed=v4-automation, autoshutdown-version=<RUNBOOK_VERSION>
   └── Poll until system-assigned identity principalId is available (up to 2 min)
3. Assign Reader to system-assigned MI at subscription scope
4. Assign Virtual Machine Contributor to system-assigned MI at subscription scope
5. Assign Automation Contributor to system-assigned MI at resource group scope
6. For each runbook (AutoShutdown, AutoStartup):
   a. Fetch PS1 content from SWA /runbooks/ endpoint
   b. Compute SHA-256 hash of content
   c. PUT runbook with publishContentLink (type: PowerShell72)
   d. POST .../publish
   e. Poll until state == 'Published' (up to 3 min)
7. For each runbook, create schedule (every 15 min, aligned to next clock boundary)
   └── startTime: next :00/:15/:30/:45 boundary at least 6 min in the future
8. Link each runbook to its schedule with parameters:
   WhatIf, WindowMinutes, TimeZoneId
```

---

## Permission Model

### User permissions (enforced by Azure)

| Operation | Minimum role | Enforcement point |
|---|---|---|
| View VMs and power state | Reader | Resource Graph — returns only accessible resources |
| Save schedule / exclude flags | Owner, Contributor, or Virtual Machine Contributor | VM PATCH API — requires `Microsoft.Compute/virtualMachines/write` |
| Install solution | Owner | ARM resource creation + role assignments |
| Update runbooks | Owner or Contributor | ARM runbook PUT + Automation Account PATCH |
| Uninstall solution | Owner | ARM resource deletion + role assignment removal |

Tag Contributor role cannot write VM tags via the VM PATCH API — Azure returns HTTP 403. The app surfaces a user-friendly error message.

### Automation Account MI permissions (set by installer)

| Role | Scope | Purpose |
|---|---|---|
| Reader | Subscription | Allows Resource Graph to return VMs in this subscription |
| Virtual Machine Contributor | Subscription | Allows deallocate and start REST calls on VMs |
| Automation Contributor | Resource group (own RG only) | Allows the account to manage its own runbooks (used by updateRunbooks) |

The system-assigned MI is scoped to a single subscription and its own resource group — no cross-subscription permissions.
