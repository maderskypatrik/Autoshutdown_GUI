# VM Auto-shutdown — Terms of Use

**PowerCloud Team · v1.0 · Internal use only**
**Last updated: 2026-04-29**

---

## 1. Overview

These Terms of Use govern the installation and use of the VM Auto-shutdown & Auto-startup solution ("the Solution") deployed via the AutoShutdown Manager web application. By clicking **Install**, the person performing the installation ("the Installer") acknowledges that they have the authority to install software into the target Azure subscription and agrees to the terms set out below.

---

## 2. What the Install Does

The installer deploys the following Azure resources into the selected subscription and resource group:

- **User-Assigned Managed Identity** — used by the Function App to authenticate against Azure
- **Storage Account** — required by Azure Functions (Standard LRS, minimal cost)
- **App Service Plan** — Consumption (Y1) plan, serverless, ~free at this scale
- **Function App** — PowerShell 7.4 runtime, runs on the Consumption plan

The Managed Identity is assigned **Virtual Machine Contributor** and **Reader** roles at subscription scope, allowing the Function App to list and control all VMs in the subscription.

Function code is loaded directly from this web application (`WEBSITE_RUN_FROM_PACKAGE`). No code is uploaded manually.

---

## 3. How the Solution Works

Once installed, the Function App runs every 15 minutes. It evaluates every VM in the subscription:

- VMs tagged `shutdown = HH:mm` are deallocated at that local time each day
- VMs tagged `startup = HH:mm` are started at that local time each day
- VMs tagged `donotshutdown` or `donotstart` are always skipped
- VMs with no relevant tags are never touched

Shutdown and startup times are evaluated in the timezone configured at install time (default: Central European Standard Time).

---

## 4. Responsibilities

### 4.1 Installer responsibilities

The Installer is responsible for:

- Ensuring they have the appropriate Azure permissions to deploy resources (Contributor on the resource group, and Owner or User Access Administrator at subscription scope for role assignments)
- Deploying into an appropriate resource group and naming resources appropriately
- Informing VM owners in the subscription that scheduled shutdown/startup is active

### 4.2 VM owner responsibilities

Anyone who adds `shutdown` or `startup` tags to a VM is responsible for:

- Ensuring the VM and its workloads can safely tolerate automated shutdown
- Adding `donotshutdown` / `donotstart` tags before maintenance windows or long-running jobs
- Managing the configured times appropriately

### 4.3 No tenant-wide impact

The Solution operates within the selected subscription only. It has no access to other subscriptions and no tenant-level permissions.

---

## 5. Disclaimer of Liability

### 5.1 No liability for data loss

**The PowerCloud Team accepts no responsibility or liability for any data loss, data corruption, service interruption, application failure, or any other damage — direct or indirect — resulting from the automated shutdown or startup of virtual machines.**

This includes but is not limited to:
- Loss of unsaved data or in-progress transactions at shutdown
- Application crashes caused by ungraceful shutdown
- Failed application startup after an automated start
- Downstream service failures caused by VM unavailability

### 5.2 No guarantee of execution

The Solution operates on a best-effort basis. Factors outside the team's control — including Azure service outages, Function App failures, or network issues — may cause a scheduled run to be delayed, skipped, or fail.

### 5.3 No liability for Azure costs

The deployed resources incur Azure costs (Storage Account, Function App execution). These costs are the responsibility of the subscription owner. At typical usage levels the cost is negligible, but the PowerCloud Team accepts no responsibility for any charges incurred.

---

## 6. Uninstallation

The Solution can be uninstalled at any time using the **Uninstall** button in the AutoShutdown Manager. This removes all deployed Azure resources and role assignments. VM tags are not modified by the uninstaller — any enrolled VMs will retain their tags but will no longer be acted on.

---

## 7. Acceptance

Clicking **I Agree** and proceeding with the installation constitutes acceptance of these Terms of Use.

If you do not agree, click Cancel.

---

*PowerCloud Team · VM Auto-shutdown Manager · Terms of Use · v1.0*
