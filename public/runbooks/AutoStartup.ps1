<#
.SYNOPSIS
    Auto-startup runbook — starts tagged VMs across all accessible subscriptions.

.DESCRIPTION
    Scheduled counterpart to AutoShutdown. Runs on a schedule inside an Azure Automation
    Account, authenticating with the account's managed identity. Discovers VMs tagged for
    startup across every accessible subscription, filters to the current time window, and
    starts those that are stopped/deallocated.

    Direct port of the former Flex Consumption function; discovery, window logic, and
    start calls are unchanged.

    Tag format:
      startup = 07:00            VM is started at 07:00 in the TimeZoneId window
      autoshutdown-enrolled      required marker tag (any value)
      donotstart                 optional opt-out (any value, case-insensitive)

.PARAMETER WhatIf
    When $true, logs intended actions without executing them.

.PARAMETER WindowMinutes
    Match window in minutes (default 15). Should match the schedule interval.

.PARAMETER TimeZoneId
    Windows time zone ID used to interpret tag times (default UTC).

.PARAMETER ClientId
    Optional client ID of a user-assigned managed identity. Omit to use the Automation
    account's system-assigned managed identity.
#>

param(
    [bool]   $WhatIf        = $false,
    [int]    $WindowMinutes = 15,
    [string] $TimeZoneId    = "UTC",
    [string] $ClientId      = ""
)

$ErrorActionPreference = 'Stop'

#region ── Authentication (managed identity) ─────────────────────────────────────
Disable-AzContextAutosave -Scope Process | Out-Null

try {
    if ([string]::IsNullOrWhiteSpace($ClientId)) {
        Connect-AzAccount -Identity -ErrorAction Stop | Out-Null
    } else {
        Connect-AzAccount -Identity -AccountId $ClientId -ErrorAction Stop | Out-Null
    }
} catch {
    Write-Error "Managed-identity sign-in failed: $_"
    throw
}
#endregion

$Tz  = [TimeZoneInfo]::FindSystemTimeZoneById($TimeZoneId)
$Now = [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $Tz)

#region ── Helpers ──────────────────────────────────────────────────────────────

function Write-Log {
    param ([string]$Message, [string]$Level = "INFO")
    Write-Output "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')][$Level] $Message"
}

function Test-InWindow {
    param ([string]$TagValue, [DateTime]$Now, [int]$WindowMinutes)
    if ([string]::IsNullOrWhiteSpace($TagValue)) { return $false }
    if ($TagValue -notmatch '^\d{1,2}:\d{2}$') { return $false }
    $parts = $TagValue -split ':'
    $h = [int]$parts[0]; $m = [int]$parts[1]
    if ($h -lt 0 -or $h -gt 23 -or $m -lt 0 -or $m -gt 59) { return $false }
    $target = $Now.Date.AddHours($h).AddMinutes($m)
    return ($Now -ge $target.AddSeconds(-30) -and $Now -lt $target.AddMinutes($WindowMinutes))
}

#endregion

Write-Log "Auto-Startup triggered. Local=$($Now.ToString('HH:mm')) TZ=$TimeZoneId WhatIf=$WhatIf Window=${WindowMinutes}min"

#region ── Resource Graph discovery ─────────────────────────────────────────────

$query = @"
Resources
| where type =~ 'microsoft.compute/virtualmachines'
    or type =~ 'microsoft.azurestackhci/virtualmachineinstances'
| where isnotnull(tags.startup)
| where isnotnull(tags['autoshutdown-enrolled'])
| project
    id, name, resourceGroup, subscriptionId, type,
    startupTime = tostring(tags.startup),
    doNotStart  = isnotnull(tags.donotstart),
    powerState  = iff(
        type =~ 'microsoft.compute/virtualmachines',
        tostring(properties.extended.instanceView.powerState.displayStatus),
        tostring(properties.instanceView.powerState)
    )
"@

$armToken = [System.Net.NetworkCredential]::new('', (Get-AzAccessToken -ResourceUrl 'https://management.azure.com').Token).Password
$subId    = (Get-AzContext).Subscription.Id
$graphUri = 'https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01'

$allTaggedVMs = [System.Collections.Generic.List[object]]::new()
$body   = @{ query = $query; subscriptions = @($subId); options = @{ '$top' = 1000 } } | ConvertTo-Json -Depth 5
$result = Invoke-RestMethod -Uri $graphUri -Method POST -Headers @{ Authorization = "Bearer $armToken" } -Body $body -ContentType 'application/json' -ErrorAction Stop
if ($result.data) { $allTaggedVMs.AddRange([object[]]($result.data)) }
while ($result.skipToken) {
    $body   = @{ query = $query; subscriptions = @($subId); options = @{ '$top' = 1000; '$skipToken' = $result.skipToken } } | ConvertTo-Json -Depth 5
    $result = Invoke-RestMethod -Uri $graphUri -Method POST -Headers @{ Authorization = "Bearer $armToken" } -Body $body -ContentType 'application/json' -ErrorAction Stop
    if ($result.data) { $allTaggedVMs.AddRange([object[]]($result.data)) }
}

Write-Log "Resource Graph: $($allTaggedVMs.Count) VM(s) have a 'startup' tag in subscription $subId."

#endregion

#region ── In-memory filtering ───────────────────────────────────────────────────

$toStart = $allTaggedVMs | Where-Object {
    if ($_.doNotStart) {
        Write-Log "  SKIP $($_.name) — tagged 'donotstart'."
        return $false
    }
    if (-not (Test-InWindow -TagValue $_.startupTime -Now $Now -WindowMinutes $WindowMinutes)) {
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
    Write-Log "== Subscription: $($group.Name) — $($group.Count) VM(s) to process"

    foreach ($vm in $group.Group) {

        $name     = $vm.name
        $rg       = $vm.resourceGroup
        $tagValue = $vm.startupTime
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

Write-Log "=============================================="
Write-Log "RUN SUMMARY  ($TimeZoneId $($Now.ToString('HH:mm')))"
Write-Log "=============================================="
Write-Log "VMs with startup tag     : $($allTaggedVMs.Count)"
Write-Log "VMs in window            : $(@($toStart).Count)"
Write-Log "VMs started              : $($stats.Started)"
Write-Log "Skipped (already running): $($stats.SkippedAlreadyOn)"
Write-Log "Errors                   : $($stats.Errors)"
Write-Log "=============================================="

if ($stats.Errors -gt 0) {
    throw "Auto-Startup completed with $($stats.Errors) error(s). Review logs above."
}

#endregion