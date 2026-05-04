<#
.SYNOPSIS
    Auto-shutdown Azure Function — shuts down tagged VMs across all accessible subscriptions.

.DESCRIPTION
    Runs every 15 minutes. Iterates every subscription the Managed Identity has access to.
    In each subscription, checks every VM's "shutdown" tag value (expected format: HH:mm local time).
    If the current local time falls within the 15-minute window starting at that time, the VM is
    deallocated. Each VM can carry a different shutdown time.

    Tag format:
      shutdown = 18:30   →  VM is deallocated at 18:30 local time (per TIMEZONE app setting)
      shutdown = 21:00   →  VM is deallocated at 21:00 local time (per TIMEZONE app setting)

    Skips:
      - VMs tagged "donotshutdown" (any value, case-insensitive)
      - VMs whose tag value is missing or not a valid HH:mm time
      - VMs outside the current 15-minute window
      - VMs already deallocated

    App settings:
      USER_ASSIGNED_MI_CLIENT_ID  — Client ID of the User-Assigned MI
      WHATIF                      — Set to "true" to log actions without executing them
      WINDOW_MINUTES              — Match window in minutes (default: 15, matches the trigger interval)
      TIMEZONE                    — Windows timezone ID for tag evaluation (default: UTC, e.g. "Central European Standard Time")
#>

param($Timer)

$WhatIf        = ($env:WHATIF -eq "true")
$WindowMinutes = if ($env:WINDOW_MINUTES) { [int]$env:WINDOW_MINUTES } else { 15 }
$TimeZoneId    = if ($env:TIMEZONE) { $env:TIMEZONE } else { "UTC" }
$Tz            = [TimeZoneInfo]::FindSystemTimeZoneById($TimeZoneId)
$Now           = [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $Tz)

#region ── Helpers ──────────────────────────────────────────────────────────────

function Write-Log {
    param ([string]$Message, [string]$Level = "INFO")
    $timestamp = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    Write-Host "[$timestamp][$Level] $Message"
}

function Test-Tag {
    param ([hashtable]$Tags, [string]$TagKey)
    if (-not $Tags) { return $false }
    return ($Tags.Keys | Where-Object { $_ -ieq $TagKey }).Count -gt 0
}

function Get-TagValue {
    param ([hashtable]$Tags, [string]$TagKey)
    if (-not $Tags) { return $null }
    $key = $Tags.Keys | Where-Object { $_ -ieq $TagKey } | Select-Object -First 1
    if ($key) { return $Tags[$key] }
    return $null
}

function Test-InWindow {
    param ([string]$TagValue, [DateTime]$Now, [int]$WindowMinutes)
    if ([string]::IsNullOrWhiteSpace($TagValue)) { return $false }
    if ($TagValue -notmatch '^\d{1,2}:\d{2}$') { return $false }
    $parts  = $TagValue -split ':'
    $hour   = [int]$parts[0]
    $minute = [int]$parts[1]
    if ($hour -lt 0 -or $hour -gt 23 -or $minute -lt 0 -or $minute -gt 59) { return $false }
    $target = $Now.Date.AddHours($hour).AddMinutes($minute)
    return ($Now -ge $target -and $Now -lt $target.AddMinutes($WindowMinutes))
}

#endregion

Write-Log "Auto-Shutdown triggered. Local=$($Now.ToString('HH:mm')) TZ=$TimeZoneId WhatIf=$WhatIf Window=${WindowMinutes}min"

#region ── Subscription enumeration ─────────────────────────────────────────────

try {
    $subscriptions = @(Get-AzSubscription -ErrorAction Stop)
} catch {
    Write-Log "Failed to list subscriptions: $_" "ERROR"
    throw
}

Write-Log "Found $($subscriptions.Count) accessible subscription(s)."

#endregion

#region ── Total counters ───────────────────────────────────────────────────────

$total = @{
    Evaluated            = 0
    ShutDown             = 0
    SkippedDoNotShutdown = 0
    SkippedNoTag         = 0
    SkippedInvalidTime   = 0
    SkippedOutsideWindow = 0
    SkippedAlreadyOff    = 0
    Errors               = 0
}

#endregion

foreach ($sub in $subscriptions) {

    Set-AzContext -SubscriptionId $sub.Id -ErrorAction Stop | Out-Null
    $subId   = $sub.Id
    $subName = $sub.Name

    Write-Log "══════════════════════════════════════════════"
    Write-Log "Processing subscription: $subName ($subId)"
    Write-Log "══════════════════════════════════════════════"

    $stats = @{
        Evaluated            = 0
        ShutDown             = 0
        SkippedDoNotShutdown = 0
        SkippedNoTag         = 0
        SkippedInvalidTime   = 0
        SkippedOutsideWindow = 0
        SkippedAlreadyOff    = 0
        Errors               = 0
    }

    #region ── 1. Classic Azure VMs ─────────────────────────────────────────────

    Write-Log "──────────────────────────────────────────────"
    Write-Log "Fetching classic Azure VMs..."

    try {
        $classicVMs = Get-AzVM -Status -ErrorAction Stop
    } catch {
        Write-Log "Failed to list classic VMs: $_" "ERROR"
        $stats.Errors++
        $classicVMs = @()
    }

    foreach ($vm in $classicVMs) {

        $stats.Evaluated++
        $name = $vm.Name
        $rg   = $vm.ResourceGroupName
        $tags = $vm.Tags

        Write-Log "Evaluating classic VM: $name (RG: $rg)"

        if (Test-Tag -Tags $tags -TagKey "donotshutdown") {
            Write-Log "  SKIP — tagged 'donotshutdown'."
            $stats.SkippedDoNotShutdown++
            continue
        }

        if (-not (Test-Tag -Tags $tags -TagKey "shutdown")) {
            Write-Log "  SKIP — no 'shutdown' tag."
            $stats.SkippedNoTag++
            continue
        }

        $tagValue = Get-TagValue -Tags $tags -TagKey "shutdown"

        if ([string]::IsNullOrWhiteSpace($tagValue) -or $tagValue -notmatch '^\d{1,2}:\d{2}$') {
            Write-Log "  SKIP — 'shutdown' tag value '$tagValue' is not a valid HH:mm time." "WARN"
            $stats.SkippedInvalidTime++
            continue
        }

        if (-not (Test-InWindow -TagValue $tagValue -Now $Now -WindowMinutes $WindowMinutes)) {
            Write-Log "  SKIP — shutdown time '$tagValue' not in current window ($($Now.ToString('HH:mm')) local)."
            $stats.SkippedOutsideWindow++
            continue
        }

        $powerState = ($vm.Statuses | Where-Object { $_.Code -like "PowerState/*" }).DisplayStatus
        if ($powerState -eq "VM deallocated") {
            Write-Log "  SKIP — already deallocated."
            $stats.SkippedAlreadyOff++
            continue
        }

        if ($WhatIf) {
            Write-Log "  [WHATIF] Would stop (deallocate) classic VM: $name (shutdown=$tagValue local)"
        } else {
            Write-Log "  ACTION — Stopping (deallocating) classic VM: $name (shutdown=$tagValue local) ..."
            try {
                Stop-AzVM -ResourceGroupName $rg -Name $name -Force -ErrorAction Stop | Out-Null
                Write-Log "  SUCCESS — VM $name deallocated."
                $stats.ShutDown++
            } catch {
                Write-Log "  ERROR   — Failed to stop VM $name : $_" "ERROR"
                $stats.Errors++
            }
        }
    }

    #endregion

    #region ── 2. Azure Local VMs ───────────────────────────────────────────────

    Write-Log "Fetching Azure Local VMs (Microsoft.AzureStackHCI/virtualMachineInstances)..."

    $localVMs       = @()
    $graphAvailable = $false

    try {
        Import-Module Az.ResourceGraph -ErrorAction Stop
        $graphAvailable = $true
    } catch {
        Write-Log "Az.ResourceGraph could not be loaded — Azure Local VM query skipped." "WARN"
    }

    if ($graphAvailable) {
        try {
            $localVMs = Search-AzGraph -Query @"
Resources
| where subscriptionId == '$subId'
| where type =~ 'microsoft.azurestackhci/virtualmachineinstances'
| project id, name, resourceGroup, tags, properties
"@ -ErrorAction Stop
        } catch {
            Write-Log "Failed to query Azure Local VMs: $_" "WARN"
            $localVMs = @()
        }
    }

    foreach ($lvm in $localVMs) {

        $stats.Evaluated++
        $name = $lvm.name
        $rg   = $lvm.resourceGroup
        $id   = $lvm.id
        $tags = $lvm.tags

        Write-Log "Evaluating Azure Local VM: $name (RG: $rg)"

        $tagsHT = @{}
        if ($tags) {
            $tags.PSObject.Properties | ForEach-Object { $tagsHT[$_.Name] = $_.Value }
        }

        if (Test-Tag -Tags $tagsHT -TagKey "donotshutdown") {
            Write-Log "  SKIP — tagged 'donotshutdown'."
            $stats.SkippedDoNotShutdown++
            continue
        }

        if (-not (Test-Tag -Tags $tagsHT -TagKey "shutdown")) {
            Write-Log "  SKIP — no 'shutdown' tag."
            $stats.SkippedNoTag++
            continue
        }

        $tagValue = Get-TagValue -Tags $tagsHT -TagKey "shutdown"

        if ([string]::IsNullOrWhiteSpace($tagValue) -or $tagValue -notmatch '^\d{1,2}:\d{2}$') {
            Write-Log "  SKIP — 'shutdown' tag value '$tagValue' is not a valid HH:mm time." "WARN"
            $stats.SkippedInvalidTime++
            continue
        }

        if (-not (Test-InWindow -TagValue $tagValue -Now $Now -WindowMinutes $WindowMinutes)) {
            Write-Log "  SKIP — shutdown time '$tagValue' not in current window ($($Now.ToString('HH:mm')) local)."
            $stats.SkippedOutsideWindow++
            continue
        }

        $powerState = $lvm.properties.instanceView.powerState
        if ($powerState -eq "Off" -or $powerState -eq "Stopped") {
            Write-Log "  SKIP — already powered off (state: $powerState)."
            $stats.SkippedAlreadyOff++
            continue
        }

        if ($WhatIf) {
            Write-Log "  [WHATIF] Would stop Azure Local VM: $name (shutdown=$tagValue local)"
        } else {
            Write-Log "  ACTION — Stopping Azure Local VM: $name (shutdown=$tagValue local) ..."
            try {
                $token  = [System.Net.NetworkCredential]::new('', (Get-AzAccessToken -ResourceUrl "https://management.azure.com").Token).Password
                $apiUri = "https://management.azure.com$($id)/stop?api-version=2023-09-01-preview"
                Invoke-RestMethod -Uri $apiUri -Method POST `
                    -Headers @{ Authorization = "Bearer $token" } `
                    -ContentType "application/json" -ErrorAction Stop | Out-Null
                Write-Log "  SUCCESS — Azure Local VM $name stop request accepted."
                $stats.ShutDown++
            } catch {
                Write-Log "  ERROR   — Failed to stop Azure Local VM $name : $_" "ERROR"
                $stats.Errors++
            }
        }
    }

    #endregion

    Write-Log "Subscription summary — $subName : Evaluated=$($stats.Evaluated) ShutDown=$($stats.ShutDown) Errors=$($stats.Errors)"

    foreach ($key in $stats.Keys) { $total[$key] += $stats[$key] }
}

#region ── Total summary ────────────────────────────────────────────────────────

Write-Log "══════════════════════════════════════════════"
Write-Log "TOTAL SUMMARY  ($TimeZoneId $($Now.ToString('HH:mm')))"
Write-Log "══════════════════════════════════════════════"
Write-Log "Subscriptions processed  : $($subscriptions.Count)"
Write-Log "VMs evaluated            : $($total.Evaluated)"
Write-Log "VMs shut down            : $($total.ShutDown)"
Write-Log "Skipped (donotshutdown)  : $($total.SkippedDoNotShutdown)"
Write-Log "Skipped (no tag)         : $($total.SkippedNoTag)"
Write-Log "Skipped (invalid time)   : $($total.SkippedInvalidTime)"
Write-Log "Skipped (outside window) : $($total.SkippedOutsideWindow)"
Write-Log "Skipped (already off)    : $($total.SkippedAlreadyOff)"
Write-Log "Errors                   : $($total.Errors)"
Write-Log "══════════════════════════════════════════════"

if ($total.Errors -gt 0) {
    throw "Auto-Shutdown completed with $($total.Errors) error(s). Review logs above."
}

#endregion
