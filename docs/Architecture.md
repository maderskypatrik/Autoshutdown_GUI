# VM Auto-shutdown Manager — Architecture

**PowerCloud Team · Last updated: 2026-05-05**

---

## System Overview

The solution has two independent layers that share data only through Azure VM tags.

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser (React SPA)                                             │
│  User authenticates via Entra ID → gets ARM access token        │
│  Calls Azure ARM APIs directly with the user's own token        │
│  Reads / writes VM tags                                         │
└──────────────────────┬───────────────────────────────────────────┘
                       │ ARM API (user's token)
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  Azure Resource Manager                                          │
│  Resource Graph (read VMs + tags + power state)                  │
│  VM PATCH API (write tags — requires virtualMachines/write)      │
└──────────────────────┬───────────────────────────────────────────┘
                       │ VM tags (shared state)
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  Azure Function App  (PowerShell, timer-triggered)               │
│  Runs every 15 min — reads tags via Resource Graph               │
│  Shuts down / starts up VMs independently of the browser        │
└──────────────────────────────────────────────────────────────────┘
```

There is no backend API, no database, and no shared secrets. The browser calls Azure directly. The Function App runs on its own timer. Both read VM tags from Azure; neither knows about the other.

---

## Frontend

### Hosting

React SPA built with Vite, deployed to **Azure Static Web Apps** via GitHub Actions. The `function-app.zip` (the Function App package) is also served as a static asset from the SWA at `/function-app.zip`.

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
│   ├── SubscriptionStatus.jsx Install status bar (checking / not installed / installed)
│   ├── VMTable.jsx            VM list with schedule editors and power state
│   ├── InstallWizard.jsx      Multi-step modal to deploy Function App into a subscription
│   └── UninstallDialog.jsx    Confirmation modal to remove all AutoShutdown resources
└── services/
    ├── azure.js               ARM read/write calls (subscriptions, RGs, VMs, tags)
    └── deploy.js              Install, uninstall, and detectInstallation logic
```

### State management (`App.jsx`)

All application state lives in `App.jsx`. No external state library. Key state:

| State | Purpose |
|---|---|
| `subscriptions` | List of subscriptions the user has access to |
| `selectedSubId` | Currently selected subscription |
| `resourceGroups` | RGs in the selected subscription |
| `selectedRg` | Currently selected RG (empty = all) |
| `vms` | VM list as returned by Resource Graph (source of truth from Azure) |
| `edits` | Map of `vmId → { shutdown, startup, noShutdown, noStart }` — local unsaved changes |
| `installStatus` | `null / 'checking' / { installed: false } / { installed: true, ...details }` |

`edits` is initialised from `vms` when VMs load, and re-synced after a successful save. `vms` is never mutated in place — it is updated with the saved tag values after a successful save.

---

## Services Layer

### `src/services/azure.js`

All direct ARM API calls. Uses the user's token — Azure enforces their RBAC.

| Function | API | Notes |
|---|---|---|
| `getSubscriptions` | `GET /subscriptions` | Lists all subscriptions the user has Reader on |
| `getResourceGroups` | `GET /subscriptions/{sub}/resourcegroups` | Lists RGs in a subscription |
| `getVMs` | Resource Graph POST | Returns VMs with tags and power state |
| `patchVMTags` | `PATCH {vmId}?api-version=2024-03-01` | Requires `Microsoft.Compute/virtualMachines/write` |

The `getVMs` Resource Graph query projects: `id`, `name`, `resourceGroup`, `tags`, `location`, `powerState`.

### `src/services/deploy.js`

Handles installation lifecycle. Uses the user's token — requires Owner on the subscription.

| Function | What it does |
|---|---|
| `detectInstallation` | Resource Graph query for a `microsoft.web/sites` resource tagged `autoshutdown-managed=v3` in the subscription |
| `installAutoShutdown` | Creates MI → Storage Account → App Service Plan → Application Insights → Function App → RBAC assignments |
| `uninstallAutoShutdown` | Removes RBAC role assignments, then deletes all resources tagged `autoshutdown-managed=v3` |

---

## Tag Schema

All scheduling data is stored as Azure tags on the VM. No other data store.

| Tag | Value format | Purpose |
|---|---|---|
| `shutdown` | `HH:mm` (e.g. `18:30`) | Daily shutdown time in configured timezone |
| `startup` | `HH:mm` (e.g. `07:00`) | Daily startup time in configured timezone |
| `autoshutdown-enrolled` | any (e.g. `true`) | Marks VM as managed — Function App ignores VMs without this tag |
| `donotshutdown` | any | Prevents automatic shutdown regardless of `shutdown` tag |
| `donotstart` | any | Prevents automatic startup regardless of `startup` tag |

**Implicit enrollment:** The UI sets `autoshutdown-enrolled` automatically when a schedule is saved (if either `shutdown` or `startup` is set) and removes it when both are cleared.

### Tags on managed infrastructure resources

| Tag | Set on | Value | Purpose |
|---|---|---|---|
| `autoshutdown-managed` | Function App, storage, plan, MI, AI | `v3` | Identifies resources owned by this solution (used by uninstall) |
| `autoshutdown-mi-principal-id` | Function App only | MI principal ID (GUID) | Used by uninstall to look up and remove RBAC role assignments |

---

## Function App

### Infrastructure

- **Runtime:** PowerShell 7.4
- **Hosting plan:** Consumption (Y1/Dynamic) — billed per execution, free tier covers normal usage
- **Deployment:** `WEBSITE_RUN_FROM_PACKAGE` pointing to `/function-app.zip` on the Static Web App URL
- **Identity:** User-Assigned Managed Identity with Reader + Virtual Machine Contributor at subscription scope
- **Monitoring:** Application Insights (connection string in app settings)
- **Module dependencies:** managed by Azure Functions (`requirements.psd1`) — `Az.Accounts 3.*`, `Az.Compute 8.*`, `Az.ResourceGraph 1.*`

> **Important:** The Function App caches the zip locally. After updating the zip (code change), the Function App must be restarted in the portal to force re-download.

### Functions

#### `Invoke-AutoShutdown` — every 15 minutes (`0 */15 * * * *`)

1. Queries Resource Graph for all VMs with both `shutdown` and `autoshutdown-enrolled` tags
2. Filters to VMs whose `shutdown` time falls within the current 15-minute window
3. Skips VMs tagged `donotshutdown`
4. Skips VMs already deallocated / powered off
5. Deallocates Azure VMs (`Stop-AzVM -Force`) or stops Azure Local VMs (REST API)

#### `Invoke-AutoStartup` — every 15 minutes (`0 */15 * * * *`)

Same logic as AutoShutdown but in reverse:

1. Queries Resource Graph for VMs with `startup` + `autoshutdown-enrolled`
2. Filters to current 15-minute window
3. Skips VMs tagged `donotstart`
4. Skips VMs already running
5. Starts Azure VMs (`Start-AzVM`) or Azure Local VMs (REST API)

#### `Invoke-Report` — daily at 06:00 UTC (`0 0 6 * * *`)

1. Lists all subscriptions the MI has access to
2. Queries Resource Graph for all VMs with `shutdown` or `startup` tags
3. Builds an HTML email summarising enrolled VMs per subscription
4. Sends via Microsoft Graph API (`POST /users/{sender}/sendMail`)

Requires `REPORT_SENDER` and `REPORT_RECIPIENT` app settings. Requires the MI to have `Mail.Send` Graph API permission (not assigned by the installer — must be added manually if the report feature is needed).

### Time window logic (`Test-InWindow`)

```
Target time: e.g. 18:30
Current time window: 18:29:30 → 18:44:59 (15 min window, 30s early buffer)

$Now >= $target.AddSeconds(-30)   ← 30s buffer for timer early-fire jitter
$Now <  $target.AddMinutes(15)    ← window end
```

The 30-second lower-bound buffer exists because Azure timer triggers can fire up to ~1 second before the scheduled boundary, causing `$Now >= $target` to fail by milliseconds on the minute boundary.

### VM type handling

The Function App handles two VM types differently:

| VM type | Resource Graph type | Stop | Start | Already-off check |
|---|---|---|---|---|
| Azure VM | `microsoft.compute/virtualmachines` | `Stop-AzVM -Force` | `Start-AzVM` | `powerState == 'VM deallocated'` |
| Azure Local (HCI) | `microsoft.azurestackhci/virtualmachineinstances` | REST `POST .../stop` | REST `POST .../start` | `powerState == 'Off' or 'Stopped'` |

### Critical implementation note — tag reading

`Search-AzGraph` returns the `tags` property as a Newtonsoft `JObject` wrapped in `PSCustomObject`. PowerShell's `PSObject.Properties` cannot enumerate JObject keys, so standard tag-reading patterns fail silently (always returning null).

**Fix:** Tag values are extracted as plain typed columns directly in the KQL query:

```kql
| project
    shutdownTime  = tostring(tags.shutdown),
    doNotShutdown = isnotnull(tags.donotshutdown)
```

This bypasses PowerShell-side tag parsing entirely. Do not use PowerShell to read `.tags.shutdown` or similar on objects returned by `Search-AzGraph`.

---

## Data Flows

### 1. User loads VMs

```
User selects subscription
  → detectInstallation (Resource Graph: find web/sites with autoshutdown-managed=v3)
  → getResourceGroups (ARM list RGs)
User clicks Load VMs
  → getVMs (Resource Graph query)
     Projects: id, name, resourceGroup, tags, location, powerState
  → App initialises edits map from current tag values
  → VMTable renders with current state
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
Timer fires
  → Test-InWindow: is current local time within any VM's window?
  → Resource Graph: find all VMs with shutdown/startup + autoshutdown-enrolled
  → For each VM in window:
     - Skip if donotshutdown / donotstart
     - Skip if already in desired power state
     - Act: Stop-AzVM or Start-AzVM (or REST for Azure Local)
  → Log summary to Application Insights
```

---

## Installer Flow (`installAutoShutdown`)

Runs entirely in the browser using the user's token (must be Owner on subscription).

```
1. Read resource group location (determines Azure region for all resources)
2. Create User-Assigned Managed Identity (mi-autoshutdown)
3. Create Storage Account (stautoshutdown{rand4}, Standard_LRS)
   └── Poll until provisioningState == Succeeded (up to 3 min)
   └── Retrieve storage key → build connection string
4. Create App Service Plan (plan-autoshutdown, Y1/Dynamic)
5. Create Application Insights (ai-{functionAppName})
6. Create Function App
   └── identity: UserAssigned (the MI from step 2)
   └── WEBSITE_RUN_FROM_PACKAGE: {SWA_URL}/function-app.zip
   └── All app settings injected at creation time
7. Assign Virtual Machine Contributor to MI at subscription scope
8. Assign Reader to MI at subscription scope
```

All created resources are tagged `autoshutdown-managed=v3` for uninstall discovery. The Function App is also tagged with `autoshutdown-mi-principal-id` (the MI principal ID) so uninstall can remove the RBAC assignments.

---

## Permission Model

### User permissions (enforced by Azure)

| Operation | Minimum role | Enforcement point |
|---|---|---|
| View VMs and power state | Reader | Resource Graph — returns only accessible resources |
| Save schedule / exclude flags | Owner, Contributor, or Virtual Machine Contributor | VM PATCH API — requires `Microsoft.Compute/virtualMachines/write` |
| Install solution | Owner | ARM resource creation + role assignments |
| Uninstall solution | Owner | ARM resource deletion + role assignment removal |

Tag Contributor role cannot write VM tags via the VM PATCH API — Azure returns HTTP 403. The app surfaces a user-friendly error message.

### Function App MI permissions (set by installer)

| Role | Scope | Purpose |
|---|---|---|
| Reader | Subscription | Allows Resource Graph to return VMs in this subscription |
| Virtual Machine Contributor | Subscription | Allows `Stop-AzVM` and `Start-AzVM` |

For multi-subscription coverage without a second installation: assign these same two roles to the same MI on additional subscriptions. The Resource Graph query and cmdlets will automatically include those subscriptions on the next run.

---

## App Settings Reference (Function App)

| Setting | Set by | Description |
|---|---|---|
| `USER_ASSIGNED_MI_CLIENT_ID` | Installer | Client ID of the User-Assigned MI — used for MI authentication |
| `TIMEZONE` | Installer | Windows timezone ID (e.g. `Central European Standard Time`) |
| `WHATIF` | Installer (default: `false`) | Set to `true` to log actions without executing them |
| `WINDOW_MINUTES` | Installer (default: `15`) | Time window width in minutes |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Installer | Application Insights telemetry |
| `APPINSIGHTS_INSTRUMENTATIONKEY` | Installer | Application Insights (legacy key, also required) |
| `AzureWebJobsStorage` | Installer | Storage account connection string (Functions runtime) |
| `WEBSITE_CONTENTAZUREFILECONNECTIONSTRING` | Installer | Storage account connection string (content share) |
| `WEBSITE_CONTENTSHARE` | Installer | Storage share name |
| `FUNCTIONS_EXTENSION_VERSION` | Installer | `~4` |
| `FUNCTIONS_WORKER_RUNTIME` | Installer | `powershell` |
| `WEBSITE_RUN_FROM_PACKAGE` | Installer | URL to `function-app.zip` on the Static Web App |
| `REPORT_SENDER` | Manual | Shared mailbox address for daily report emails |
| `REPORT_RECIPIENT` | Manual | Recipient address(es) for daily report emails |
