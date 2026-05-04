# VM Auto-shutdown Manager — User Guide

**PowerCloud Team · v1.1**
**Last updated: 2026-05-04**

---

## Overview

VM Auto-shutdown Manager is a web app that lets you set daily shutdown and startup schedules for Azure Virtual Machines. Schedules are stored as tags directly on the VM — there is no separate database or configuration file. Changes take effect the next time the scheduled Function App runs (every 15 minutes).

---

## Required Azure Roles

Your access level determines what you can do in the app.

| What you want to do | Minimum required role |
|---|---|
| Sign in and view VMs | **Reader** on the subscription or resource group |
| Enroll or unenroll a VM | **Virtual Machine Contributor** or **Owner** on the VM |
| Set or change shutdown / startup times | **Tag Contributor**, **Contributor**, or **Owner** on the subscription or resource group |
| Exclude a VM from shutdown or startup | Same as above |
| Install the AutoShutdown solution into a subscription | **Owner** on the subscription |

> If you can see VMs but the **Save Changes** button stays disabled, you likely have Reader access only. Contact your Azure administrator to request Tag Contributor or higher.

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

### 3 — Load VMs

Click the **Load VMs** button. The table below populates with all VMs found in the selected scope.

---

## Reading the VM Table

| Column | Description |
|---|---|
| **VM Name** | The name of the virtual machine in Azure |
| **Resource Group** | The resource group the VM belongs to |
| **Shutdown** | The daily shutdown time in `HH:mm` (24-hour) format |
| **Startup** | The daily startup time in `HH:mm` (24-hour) format |
| **Do Not Shutdown** | When checked, the VM is never shut down regardless of the shutdown time |
| **Do Not Start** | When checked, the VM is never started regardless of the startup time |

Empty **Shutdown** or **Startup** fields mean no schedule is set for that action.

Times are interpreted in the timezone configured for the subscription's installation (default: `Central European Standard Time`).

---

## Enrolling a VM

Before the automation will act on a VM, it must be explicitly enrolled. This is a deliberate step that requires **VM Contributor or Owner** role on the VM — it cannot be done by someone with Tag Contributor alone.

1. Find the VM in the table
2. Click **Enroll** in the Enrollment column
3. The app checks your permissions on that VM — if insufficient, an error is shown
4. If permitted, the VM is marked as enrolled and the automation will process it

To remove a VM from automation, click **Unenroll**. The VM's tags are preserved but the automation will no longer act on it.

---

## Setting a Schedule

1. Enroll the VM first (see above) — the time and exclude fields are disabled until the VM is enrolled
2. Click the **Shutdown** field and type a time in `HH:mm` format (e.g. `18:00`)
3. Click the **Startup** field and type a time in `HH:mm` format (e.g. `07:00`)
4. Rows with unsaved changes are highlighted — the footer shows how many VMs have pending changes
5. Click **Save Changes**

You can set only one of the two times if needed (e.g. auto-shutdown with no auto-startup).

> Hovering over a disabled field on an unenrolled VM shows **"Enroll this VM first"**.

---

## Excluding a VM

If a VM should never be shut down or started by the automation regardless of any time set:

- Check **Do Not Shutdown** to prevent automatic shutdown
- Check **Do Not Start** to prevent automatic startup

These flags take priority over any time values set on the same VM.

---

## Removing a Schedule

Clear the **Shutdown** or **Startup** field (delete the value) and click **Save Changes**. The corresponding tag is removed from the VM and the automation will no longer act on it for that action.

Unchecking **Do Not Shutdown** or **Do Not Start** removes those exclusion tags.

---

## Installing the Solution into a Subscription

If the selected subscription has never had the AutoShutdown solution set up, a notice appears below the subscription selector. You must be an **Owner** of that subscription to proceed.

Clicking **Install** opens a wizard that:

1. Creates a User-Assigned Managed Identity
2. Creates a Storage Account
3. Creates a Consumption App Service Plan
4. Deploys the Function App with the shutdown/startup logic
5. Assigns the Managed Identity Reader and VM Contributor roles on the subscription

The installation takes approximately 2–5 minutes. Once complete, the Function App runs every 15 minutes and acts on any VMs that have the relevant tags.

### Covering additional subscriptions

One installed Function App can manage VMs across multiple subscriptions without installing again. Ask your Azure administrator to assign the Managed Identity (tagged `autoshutdown-mi-principal-id` on the Function App) the **Reader** and **Virtual Machine Contributor** roles on any additional subscription. The Function App will automatically include those subscriptions on its next run.

---

## How Schedules Work

- The Function App runs every 15 minutes
- It uses a single Azure Resource Graph query to find all VMs with `shutdown` or `startup` tags across every subscription it has access to
- VMs whose scheduled time falls within the current 15-minute window are shut down or started
- VMs already in the desired power state are skipped
- Changes you save in the app take effect within 15 minutes at most

---

## Troubleshooting

### No subscriptions appear after signing in
You do not have Reader access to any subscription. Contact your Azure administrator.

### VMs do not appear after clicking Load VMs
You may not have access to the selected resource group. Try selecting **All** in the Resource Group dropdown, or contact your administrator.

### Save Changes button is disabled
You have read-only access (Reader role). You need Tag Contributor, Contributor, or Owner to write tags. Contact your administrator.

### VM did not shut down or start at the scheduled time
- Confirm the time was saved correctly — reload the page and check the value still appears
- Verify the AutoShutdown solution is installed in the subscription (a status indicator appears below the subscription selector)
- Check that **Do Not Shutdown** / **Do Not Start** is not checked for that VM
- The Function App runs every 15 minutes — allow up to 15 minutes after the scheduled time

---

*PowerCloud Team · VM Auto-shutdown Manager · User Guide · v1.0*
