# VM Scheduler — User Guide

**PowerCloud Team · v2.0**
**Last updated: 2026-06-01**

---

## Overview

VM Scheduler is a web app that lets you set daily shutdown and startup schedules for Azure Virtual Machines. Schedules are stored as tags directly on the VM — there is no separate database or configuration file. Changes take effect at the next scheduled run (every 15 minutes).

The app refreshes VM power states automatically every 30 seconds while the table is open — no manual reload needed to see whether a VM is running or stopped.

---

## Required Azure Roles

Your access level determines what you can do in the app.

| What you want to do | Minimum required role |
|---|---|
| Sign in and view VMs | **Reader** on the subscription or resource group |
| Set or change shutdown / startup times | **Virtual Machine Contributor**, **Contributor**, or **Owner** on the subscription, resource group, or VM |
| Install the VM Scheduler into a subscription | **Owner** on the subscription |
| Update the VM Scheduler runbooks | **Owner** or **Contributor** on the subscription |
| Uninstall the VM Scheduler | **Owner** on the subscription |

> If you can see VMs but cannot save changes, you have Reader access only. Contact your Azure administrator to request Virtual Machine Contributor or higher.

---

## Signing In

1. Open the app URL provided by your administrator
2. Click **Sign in with Microsoft**
3. You will be redirected to the Microsoft login page — pick your work or school account
4. After signing in you are redirected back to the app automatically

To sign out, click your username in the top-right corner and select **Sign out**.

---

## Navigating the App

### 1 — Select a Subscription

After signing in, the **Subscription** dropdown at the top populates with all Azure subscriptions your account has access to. Select the one containing the VMs you want to manage.

If a subscription does not appear, you do not have at least Reader access to it.

### 2 — Select a Resource Group (optional)

Once a subscription is selected, the **Resource Group** dropdown populates. Selecting a resource group limits the VM list to that group only. Leave it set to **All** to see every VM in the subscription.

### 3 — Check the install status banner

Below the dropdowns, a status bar shows whether the VM Scheduler is installed in the selected subscription:

| Banner | Meaning |
|---|---|
| ○ Not installed | No Automation Account found — schedules can be saved as tags but no runbook will act on them |
| ✓ Installed | The Automation Account is running and will act on scheduled VMs |
| ✓ Installed + **Update available** | A newer runbook version is available — click the amber button to update |

### 4 — Load VMs

Click the **Load VMs** button. The table below populates with all VMs found in the selected scope.

---

## Reading the VM Table

| Column | Description |
|---|---|
| **VM Name** | The name of the virtual machine in Azure |
| **Resource Group** | The resource group the VM belongs to |
| **Status** | Current power state of the VM — refreshes every 30 seconds automatically |
| **Shutdown** | The daily shutdown time in `HH:mm` (24-hour) format — leave empty for no shutdown |
| **Startup** | The daily startup time in `HH:mm` (24-hour) format — leave empty for no startup |
| **Weekdays only** | When checked, shutdown and startup are skipped on Saturday and Sunday |

Times are interpreted in the timezone configured for the subscription's Automation Account (default: `Central European Standard Time`).

---

## Setting a Schedule

1. Click the **Shutdown** field and type a time in `HH:mm` format (e.g. `18:00`)
2. Click the **Startup** field and type a time in `HH:mm` format (e.g. `07:00`)
3. Rows with unsaved changes are highlighted — the footer shows how many VMs have pending changes
4. Click **Save Changes**

You can set only one of the two times if needed (e.g. auto-shutdown with no auto-startup).

Saving a schedule automatically enrolls the VM into the automation. Clearing both times and saving removes it from the automation. There is no separate enroll step.

---

## Weekdays Only (Mon–Fri)

Checking the **Weekdays only** checkbox tells the automation to skip shutdown and startup on Saturday and Sunday — the VM stays off for the entire weekend without any manual action.

**Example:** shutdown `18:00`, startup `07:00`, Weekdays only checked:

| Day | What happens |
|---|---|
| Monday – Thursday | VM starts at 07:00, shuts down at 18:00 as normal |
| Friday 18:00 | Automation shuts the VM down |
| Saturday 07:00 | Automation sees "weekdays only" + today is Saturday → skips startup |
| Sunday 07:00 | Same — skips startup |
| Monday 07:00 | Automation starts the VM normally |

The VM stays deallocated all weekend — compute cost drops to zero. Only the OS disk continues to bill.

> This option only makes sense when a startup time is set. If you have no startup time configured, the VM will not start on any day regardless of this setting.

---

## Removing a Schedule

Clear the **Shutdown** or **Startup** field (delete the value) and click **Save Changes**. The corresponding tag is removed from the VM and the automation will no longer act on it for that action.

---

## Installing the Solution into a Subscription

If the selected subscription has never had the VM Scheduler set up, a notice appears below the subscription selector. You must be an **Owner** of that subscription to proceed.

Clicking **Install** opens a wizard that:

1. Accepts the Terms of Use
2. Lets you choose a Resource Group, Automation Account name, and timezone
3. Creates an **Azure Automation Account** with a system-assigned managed identity
4. Assigns the managed identity Reader and Virtual Machine Contributor roles at subscription scope, and Automation Contributor at resource group scope
5. Publishes VM Scheduler and AutoStartup runbooks into the account
6. Creates schedules that fire every 15 minutes, aligned to clock boundaries

The installation takes approximately 3–5 minutes. Once complete, the runbooks will act on any VMs that have the relevant tags, starting from the next 15-minute interval.

If your administrator has configured the Confluence integration, the subscription is automatically added to the team's deployment registry page in Confluence when installation completes.

---

## Updating the Runbooks

When a new version of the VM Scheduler runbooks is released, an amber **"Update available"** button appears in the install status bar.

Clicking it opens a dialog that re-publishes both runbooks into your existing Automation Account without removing any resources, schedules, or role assignments. The update takes about 1–2 minutes. No reinstall is needed.

---

## Uninstalling the Solution

Clicking **Uninstall** opens a confirmation dialog that:

- Removes all RBAC role assignments made by the installer
- Deletes the Automation Account (the system-assigned managed identity is deleted automatically with it)

VM tags are not modified by the uninstaller — any enrolled VMs will retain their schedule tags but will no longer be acted on.

If the Confluence integration is configured, the subscription is automatically removed from the team's deployment registry page when uninstallation completes.

---

## How Schedules Work

- The Automation Account runbooks run every 15 minutes, aligned to clock boundaries (`:00`, `:15`, `:30`, `:45`)
- Each runbook queries Azure Resource Graph for all VMs with the relevant tags in the subscription
- VMs whose scheduled time falls within the current 15-minute window are shut down or started
- VMs already in the desired power state are skipped
- Changes you save in the app take effect within 15 minutes at most

---

## Viewing Run Logs

The Automation Account logs every execution. To view them:

1. Open the **Azure Portal** → navigate to the Automation Account (in the resource group you chose at install time)
2. In the left menu, click **Jobs**
3. Select a job to see the full output log — which VMs were found, acted on, skipped, or errored

---

## Troubleshooting

### Installation fails with "HTTP 409"

Automation Account names must be unique within the Azure region. If the name you entered is already taken, Azure returns HTTP 409.

**Fix:** retry the installation with a more unique name, e.g. `aa-autoshutdown-yourcompany`.

### No subscriptions appear after signing in

You do not have Reader access to any subscription. Contact your Azure administrator.

### VMs do not appear after clicking Load VMs

You may not have access to the selected resource group. Try selecting **All** in the Resource Group dropdown, or contact your administrator.

### Save Changes fails or shows a permission error

You do not have sufficient permissions. All modifications require **Virtual Machine Contributor**, **Contributor**, or **Owner** on the subscription, resource group, or VM. Contact your Azure administrator.

### VM did not shut down or start at the scheduled time

- Confirm the time was saved correctly — reload the page and check the value still appears
- Verify the VM Scheduler is installed in the subscription (the status banner shows this)
- The runbooks fire every 15 minutes — allow up to 15 minutes after the scheduled time
- Check the Automation Account Jobs in the Azure Portal for any errors on that run

### VM is stuck in "Starting" or "Deallocating" after a scheduled run

The runbook fires a REST call to start or deallocate the VM and receives `202 Accepted` — Azure handles the actual operation asynchronously. If the VM gets stuck in a transitional state, the runbook has already completed successfully and will not retry until the next scheduled time window.

**Recovery steps:**

1. **Wait up to 15–20 minutes** — Azure will usually force-complete the operation on its own
2. If still stuck: Azure Portal → VM → click **Stop** to force deallocation, then **Start** again
3. Check **Boot diagnostics** (left menu on the VM) for errors that may explain why startup failed
4. If the problem repeats: open an Azure Support ticket for that VM

> **Important for critical VMs:** the automation operates on a best-effort basis and does not monitor whether the VM reached its target state after a scheduled action. For VMs running critical workloads, set up an independent **Azure Monitor alert** (e.g. alert if VM heartbeat stops for more than N minutes) so your team is notified if the VM is unexpectedly unavailable.

### VM power state in the app does not match the Azure Portal

The app refreshes power state every 30 seconds automatically. If it still shows a stale state, click **Load VMs** to do a full reload.

---

*PowerCloud Team · VM Scheduler · User Guide · v2.0*
