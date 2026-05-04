<#
.SYNOPSIS
    Auto-shutdown Azure Function — shuts down tagged VMs across all accessible subscriptions.

.DESCRIPTION
    Runs every 15 minutes. Uses a single Resource Graph query to discover all VMs with a
    "shutdown" tag across every accessible subscription, filters to those in the current
    time window, then deallocates only those VMs. Scales to any number of subscriptions.

    Tag format:
      shutdown = 18:30   →  VM is deallocated at 18:30 local time (per TIMEZONE app setting)

    Skips:
      - VMs tagged "donotshutdown" (any value, case-insensitive)
      - VMs whose tag value is missing or not a valid HH:mm time
      - VMs outside the current 15-minute window
      - VMs already deallocated / powered off

    App settings:
      USER_ASSIGNED_MI_CLIENT_ID  — Client ID of the User-Assigned MI
      WHATIF                      — Set to "true" to log actions without executing them
      WINDOW_MINUTES              — Match window in minutes (default: 15)
      TIMEZONE                    — Windows timezone ID (default: UTC)
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
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')][$Level] $Message"
}

function Test-InWindow {
    param ([string]$TagValue, [DateTime]$Now, [int]$WindowMinutes)
    if ([string]::IsNullOrWhiteSpace($TagValue)) { return $false }
    if ($TagValue -notmatch '^\d{1,2}:\d{2}$') { return $false }
    $parts = $TagValue -split ':'
    $h = [int]$parts[0]; $m = [int]$parts[1]
    if ($h -lt 0 -or $h -gt 23 -or $m -lt 0 -or $m -gt 59) { return $false }
    $target = $Now.Date.AddHours($h).AddMinutes($m)
    return ($Now -ge $target -and $Now -lt $target.AddMinutes($WindowMinutes))
}

function Get-ObjTagValue {
    param ($Tags, [string]$Key)
    if (-not $Tags) { return $null }
    $prop = $Tags.PSObject.Properties | Where-Object { $_.Name -ieq $Key } | Select-Object -First 1
    return $prop?.Value
}

function Test-ObjTag {
    param ($Tags, [string]$Key)
    if (-not $Tags) { return $false }
    return ($Tags.PSObject.Properties.Name | Where-Object { $_ -ieq $Key }).Count -gt 0
}

#endregion

Write-Log "Auto-Shutdown triggered. Local=$($Now.ToString('HH:mm')) TZ=$TimeZoneId WhatIf=$WhatIf Window=${WindowMinutes}min"

#region ── Resource Graph discovery ─────────────────────────────────────────────

try {
    Import-Module Az.ResourceGraph -ErrorAction Stop
} catch {
    Write-Log "Az.ResourceGraph module is required but could not be loaded." "ERROR"
    throw
}

$query = @"
Resources
| where type =~ 'microsoft.compute/virtualmachines'
    or type =~ 'microsoft.azurestackhci/virtualmachineinstances'
| where isnotnull(tags.shutdown)
| project
    id, name, resourceGroup, subscriptionId, type, tags,
    powerState = iff(
        type =~ 'microsoft.compute/virtualmachines',
        tostring(properties.extended.instanceView.powerState.displayStatus),
        tostring(properties.instanceView.powerState)
    )
"@

$allTaggedVMs = [System.Collections.Generic.List[object]]::new()
try {
    $result = Search-AzGraph -Query $query -First 1000 -ErrorAction Stop
    $allTaggedVMs.AddRange([object[]]@($result))
    while ($result.SkipToken) {
        $result = Search-AzGraph -Query $query -First 1000 -SkipToken $result.SkipToken -ErrorAction Stop
        $allTaggedVMs.AddRange([object[]]@($result))
    }
} catch {
    Write-Log "Resource Graph query failed: $_" "ERROR"
    throw
}

Write-Log "Resource Graph: $($allTaggedVMs.Count) VM(s) have a 'shutdown' tag across all subscriptions."

#endregion

#region ── In-memory filtering ───────────────────────────────────────────────────

$toShutdown = $allTaggedVMs | Where-Object {
    if (Test-ObjTag -Tags $_.tags -Key 'donotshutdown') {
        Write-Log "  SKIP $($_.name) — tagged 'donotshutdown'."
        return $false
    }
    $tagValue = Get-ObjTagValue -Tags $_.tags -Key 'shutdown'
    if (-not (Test-InWindow -TagValue $tagValue -Now $Now -WindowMinutes $WindowMinutes)) {
        return $false
    }
    return $true
}

Write-Log "$(@($toShutdown).Count) VM(s) are in the current shutdown window."

#endregion

#region ── Act ───────────────────────────────────────────────────────────────────

$stats = @{ ShutDown = 0; SkippedAlreadyOff = 0; Errors = 0 }

$grouped = @($toShutdown | Group-Object subscriptionId)
foreach ($group in $grouped) {

    Set-AzContext -SubscriptionId $group.Name -ErrorAction Stop | Out-Null
    Write-Log "══ Subscription: $($group.Name) — $($group.Count) VM(s) to process"

    foreach ($vm in $group.Group) {

        $name     = $vm.name
        $rg       = $vm.resourceGroup
        $tagValue = Get-ObjTagValue -Tags $vm.tags -Key 'shutdown'
        $isLocal  = $vm.type -ilike '*azurestackhci*'

        Write-Log "  $name (RG: $rg) shutdown=$tagValue type=$(if ($isLocal) { 'AzureLocal' } else { 'AzureVM' })"

        if ($isLocal) {

            $powerState = $vm.powerState
            if ($powerState -eq 'Off' -or $powerState -eq 'Stopped') {
                Write-Log "    SKIP — already off (state: $powerState)."
                $stats.SkippedAlreadyOff++
                continue
            }
            if ($WhatIf) {
                Write-Log "    [WHATIF] Would stop Azure Local VM: $name"
            } else {
                try {
                    $token  = [System.Net.NetworkCredential]::new('', (Get-AzAccessToken -ResourceUrl 'https://management.azure.com').Token).Password
                    $apiUri = "https://management.azure.com$($vm.id)/stop?api-version=2023-09-01-preview"
                    Invoke-RestMethod -Uri $apiUri -Method POST -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' -ErrorAction Stop | Out-Null
                    Write-Log "    SUCCESS — Azure Local VM $name stop request accepted."
                    $stats.ShutDown++
                } catch {
                    Write-Log "    ERROR — $_ " "ERROR"
                    $stats.Errors++
                }
            }

        } else {

            $powerState = $vm.powerState
            if ($powerState -eq 'VM deallocated') {
                Write-Log "    SKIP — already deallocated."
                $stats.SkippedAlreadyOff++
                continue
            }
            if ($WhatIf) {
                Write-Log "    [WHATIF] Would stop (deallocate) VM: $name"
            } else {
                try {
                    Stop-AzVM -ResourceGroupName $rg -Name $name -Force -ErrorAction Stop | Out-Null
                    Write-Log "    SUCCESS — VM $name deallocated."
                    $stats.ShutDown++
                } catch {
                    Write-Log "    ERROR — $_" "ERROR"
                    $stats.Errors++
                }
            }
        }
    }
}

#endregion

#region ── Summary ──────────────────────────────────────────────────────────────

Write-Log "══════════════════════════════════════════════"
Write-Log "RUN SUMMARY  ($TimeZoneId $($Now.ToString('HH:mm')))"
Write-Log "══════════════════════════════════════════════"
Write-Log "VMs with shutdown tag    : $($allTaggedVMs.Count)"
Write-Log "VMs in window            : $(@($toShutdown).Count)"
Write-Log "VMs shut down            : $($stats.ShutDown)"
Write-Log "Skipped (already off)    : $($stats.SkippedAlreadyOff)"
Write-Log "Errors                   : $($stats.Errors)"
Write-Log "══════════════════════════════════════════════"

if ($stats.Errors -gt 0) {
    throw "Auto-Shutdown completed with $($stats.Errors) error(s). Review logs above."
}

#endregion
