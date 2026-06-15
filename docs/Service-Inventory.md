# VM Scheduler — Service Inventory

**PowerCloud Team · Last updated: 2026-06-15**

---

## Environment

| Field | Value |
|---|---|
| Type | Production |
| Azure Subscription | `POWERCO.powerco-prod-powerco-prod-cloud-ops` |
| Subscription ID | `6c6c6907-5d81-491d-a044-aff580f6dd5b` |
| Subscription purpose | Hosts the Azure Static Web App (frontend + API functions) |

---

## GitHub Repository

`https://github.com/PowerCo/Autoshutdown_GUI`

---

## Service Principal Accounts (SPNs)

| Name | Application (Client) ID | Purpose |
|---|---|---|
| `github-swa-autoshutdown` | `92434e29-142c-45ef-9ac5-18674851afc9` | Entra ID app registration — users authenticate through this SPN via MSAL |

---

## Allowed Permissions

### `github-swa-autoshutdown` SPN

| Role | Scope |
|---|---|
| Contributor | Resource group `rg-poc-autoshutdown` |

### Developer access

Access to the subscription is managed via Entra ID groups:

| Group | Role | Scope |
|---|---|---|
| `POWERCO.powerco-prod.powerco-prod-cloud-ops.Owner` | Owner | Subscription |
| `POWERCO.powerco-prod.powerco-prod-cloud-ops.Contributors` | Contributor | Subscription |
| `POWERCO.powerco-prod.powerco-prod-cloud-ops.Readers` | Reader | Subscription |

---

## Customer Documentation

| Resource | URL |
|---|---|
| VM Scheduler app | `https://lively-water-05d760803.7.azurestaticapps.net` (will change to `https://vmscheduler.cloud.powerco.tech` once custom domain is live) |
| Cloud Portfolio service page | `https://cloud.powerco.tech/service/vm-scheduler` (live once `feature/49873-vm-scheduler-card` PR is merged) |
| Architecture documentation | See `Architecture.md` in this repository |
