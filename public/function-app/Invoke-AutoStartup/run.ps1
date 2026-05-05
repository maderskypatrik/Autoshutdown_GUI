<#
.SYNOPSIS
    Auto-startup Azure Function — starts tagged VMs across all accessible subscriptions.

.DESCRIPTION
    Runs every 15 minutes. Uses a single Resource Graph query to discover all VMs with a
    "startup" tag across every accessible subscription, filters to those in the current
    time window, then starts only those VMs. Scales to any number of subscriptions.

    Tag format:
      startup = 07:00   →  VM is started at 07:00 local time (per TIMEZONE app setting)

    Skips:
      - VMs tagged "donotstart" (any value, case-insensitive)
      - VMs whose tag value is missing or not a valid HH:mm time
      - VMs outside the current 15-minute window
      - VMs already running

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
    # Allow 30s buffer: Azure timer triggers sometimes fire up to ~1s before the scheduled boundary
    return ($Now -ge $target.AddSeconds(-30) -and $Now -lt $target.AddMinutes($WindowMinutes))
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

Write-Log "Auto-Startup triggered. Local=$($Now.ToString('HH:mm')) TZ=$TimeZoneId WhatIf=$WhatIf Window=${WindowMinutes}min"

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
| where isnotnull(tags.startup)
| where isnotnull(tags['autoshutdown-enrolled'])
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

Write-Log "Resource Graph: $($allTaggedVMs.Count) VM(s) have a 'startup' tag across all subscriptions."

#endregion

#region ── In-memory filtering ───────────────────────────────────────────────────

$toStart = $allTaggedVMs | Where-Object {
    if (Test-ObjTag -Tags $_.tags -Key 'donotstart') {
        Write-Log "  SKIP $($_.name) — tagged 'donotstart'."
        return $false
    }
    $tagValue = Get-ObjTagValue -Tags $_.tags -Key 'startup'
    if (-not (Test-InWindow -TagValue $tagValue -Now $Now -WindowMinutes $WindowMinutes)) {
        return $false
    }
    return $true
}

Write-Log "$(@($toStart).Count) VM(s) are in the current startup window."

#endregion

#region ── Act ───────────────────────────────────────────────────────────────────

$stats = @{ Started = 0; SkippedAlreadyOn = 0; Errors = 0 }

$grouped = @($toStart | Group-Object subscriptionId)
foreach ($group in $grouped) {

    Set-AzContext -SubscriptionId $group.Name -ErrorAction Stop | Out-Null
    Write-Log "══ Subscription: $($group.Name) — $($group.Count) VM(s) to process"

    foreach ($vm in $group.Group) {

        $name     = $vm.name
        $rg       = $vm.resourceGroup
        $tagValue = Get-ObjTagValue -Tags $vm.tags -Key 'startup'
        $isLocal  = $vm.type -ilike '*azurestackhci*'

        Write-Log "  $name (RG: $rg) startup=$tagValue type=$(if ($isLocal) { 'AzureLocal' } else { 'AzureVM' })"

        if ($isLocal) {

            $powerState = $vm.powerState
            if ($powerState -eq 'Running') {
                Write-Log "    SKIP — already running (state: $powerState)."
                $stats.SkippedAlreadyOn++
                continue
            }
            if ($WhatIf) {
                Write-Log "    [WHATIF] Would start Azure Local VM: $name"
            } else {
                try {
                    $token  = [System.Net.NetworkCredential]::new('', (Get-AzAccessToken -ResourceUrl 'https://management.azure.com').Token).Password
                    $apiUri = "https://management.azure.com$($vm.id)/start?api-version=2023-09-01-preview"
                    Invoke-RestMethod -Uri $apiUri -Method POST -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' -ErrorAction Stop | Out-Null
                    Write-Log "    SUCCESS — Azure Local VM $name start request accepted."
                    $stats.Started++
                } catch {
                    Write-Log "    ERROR — $_" "ERROR"
                    $stats.Errors++
                }
            }

        } else {

            $powerState = $vm.powerState
            if ($powerState -eq 'VM running') {
                Write-Log "    SKIP — already running."
                $stats.SkippedAlreadyOn++
                continue
            }
            if ($WhatIf) {
                Write-Log "    [WHATIF] Would start VM: $name"
            } else {
                try {
                    Start-AzVM -ResourceGroupName $rg -Name $name -ErrorAction Stop | Out-Null
                    Write-Log "    SUCCESS — VM $name started."
                    $stats.Started++
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
Write-Log "VMs with startup tag     : $($allTaggedVMs.Count)"
Write-Log "VMs in window            : $(@($toStart).Count)"
Write-Log "VMs started              : $($stats.Started)"
Write-Log "Skipped (already running): $($stats.SkippedAlreadyOn)"
Write-Log "Errors                   : $($stats.Errors)"
Write-Log "══════════════════════════════════════════════"

if ($stats.Errors -gt 0) {
    throw "Auto-Startup completed with $($stats.Errors) error(s). Review logs above."
}

#endregion
