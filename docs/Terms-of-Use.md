# VM Auto-shutdown — Terms of Use

**PowerCloud Team · v2.0 · Internal use only**
**Last updated: 2026-06-01**

---

## 1. Overview

These Terms of Use govern the installation and use of the VM Auto-shutdown & Auto-startup solution ("the Solution") deployed via the AutoShutdown Manager web application. By clicking **Install**, the person performing the installation ("the Installer") acknowledges that they have the authority to install software into the target Azure subscription and agrees to the terms set out below.

---

## 2. What the Install Does

The installer deploys the following Azure resources into the selected subscription and resource group:

- **Azure Automation Account** — hosts the shutdown and startup runbooks; runs on a 15-minute schedule
- **System-assigned managed identity** — created automatically with the Automation Account; used to authenticate against Azure Resource Manager

The following RBAC role assignments are made:

- **Reader** at subscription scope — allows the runbooks to query Resource Graph for VMs
- **Virtual Machine Contributor** at subscription scope — allows the runbooks to deallocate and start VMs
- **Automation Contributor** at resource group scope — scoped to the Automation Account's own resource group only

No storage account, application insights, or other auxiliary resources are created. There is no inbound surface — the Automation Account only makes outbound calls to Azure Resource Manager.

---

## 3. How the Solution Works

Once installed, the Automation Account runs two PowerShell runbooks every 15 minutes:

- **AutoShutdown** — VMs tagged `shutdown = HH:mm` are deallocated at that local time each day
- **AutoStartup** — VMs tagged `startup = HH:mm` are started at that local time each day
- VMs tagged `donotshutdown` or `donotstart` are always skipped for the respective action
- VMs with no relevant tags are never touched

Shutdown and startup times are evaluated in the timezone configured at install time (default: Central European Standard Time).

The Automation Account operates within the subscription it was installed into only. It has no access to other subscriptions.

---

## 4. Responsibilities

### 4.1 Installer responsibilities

The Installer is responsible for:

- Ensuring they have the appropriate Azure permissions (Owner on the subscription) to deploy resources and assign roles
- Deploying into an appropriate resource group and naming the Automation Account appropriately
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

The Solution operates on a best-effort basis. Factors outside the team's control — including Azure service outages, Automation Account job failures, or Resource Graph indexing delays — may cause a scheduled run to be delayed, skipped, or fail.

### 5.3 No liability for Azure costs

The deployed resources incur minimal Azure costs (Azure Automation free tier includes 500 job minutes/month; typical usage is well within this limit). These costs are the responsibility of the subscription owner. The PowerCloud Team accepts no responsibility for any charges incurred.

---

## 6. Updates

When a new version of the runbooks is released, users will see an **"Update available"** button in the app. Clicking it re-publishes the runbooks into the existing Automation Account without removing any resources or schedules. Updates do not require reinstallation.

---

## 7. Uninstallation

The Solution can be uninstalled at any time using the **Uninstall** button in the AutoShutdown Manager. This removes all RBAC role assignments and deletes the Automation Account (the system-assigned managed identity is deleted automatically with it). VM tags are not modified by the uninstaller — any enrolled VMs will retain their tags but will no longer be acted on.

---

## 8. Acceptance

Clicking **I Agree** and proceeding with the installation constitutes acceptance of these Terms of Use.

If you do not agree, click Cancel.

---

*PowerCloud Team · VM Auto-shutdown Manager · Terms of Use · v2.0*
