<#
.SYNOPSIS
    Auto-shutdown runbook — deallocates tagged VMs across all accessible subscriptions.

.DESCRIPTION
    Designed to run on a schedule (e.g. every 15 minutes) inside an Azure Automation
    Account, authenticating with the account's managed identity. Uses a single Resource
    Graph query to discover all VMs tagged for shutdown across every subscription the
    identity can read, filters to those in the current time window, and deallocates them.

    This is a direct port of the former Flex Consumption function. The VM-discovery query,
    time-window matching, and start/stop logic are unchanged. What changed:
      - No Functions trigger wrapper, no profile.ps1 auth gymnastics, no package in a
        locked-down storage account, no singleton lease, no cold-start indexing race.
      - Auth is a single managed-identity Connect-AzAccount at the top (runs in a fully
        initialised runbook sandbox, so there is no race to lose).
      - Config comes from runbook parameters instead of app settings.

    Tag format:
      shutdown = 18:30           VM is deallocated at 18:30 in the TimeZoneId window
      autoshutdown-enrolled      required marker tag (any value)
      donotshutdown              optional opt-out (any value, case-insensitive)

.PARAMETER WhatIf
    When $true, logs intended actions without executing them.

.PARAMETER WindowMinutes
    Match window in minutes (default 15). Should match the schedule interval.

.PARAMETER TimeZoneId
    Windows time zone ID used to interpret tag times (default UTC).
    e.g. "Central European Standard Time".

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
# Disable context autosave so parallel/again runs don't collide on a shared context.
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

Write-Log "Auto-Shutdown triggered. Local=$($Now.ToString('HH:mm')) TZ=$TimeZoneId WhatIf=$WhatIf Window=${WindowMinutes}min"

#region ── Resource Graph discovery ─────────────────────────────────────────────

$query = @"
Resources
| where type =~ 'microsoft.compute/virtualmachines'
    or type =~ 'microsoft.azurestackhci/virtualmachineinstances'
| where isnotnull(tags.shutdown)
| where isnotnull(tags['autoshutdown-enrolled'])
| project
    id, name, resourceGroup, subscriptionId, type,
    shutdownTime  = tostring(tags.shutdown),
    doNotShutdown = isnotnull(tags.donotshutdown),
    powerState    = iff(
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

Write-Log "Resource Graph: $($allTaggedVMs.Count) VM(s) have a 'shutdown' tag in subscription $subId."

#endregion

#region ── In-memory filtering ───────────────────────────────────────────────────

$toShutdown = $allTaggedVMs | Where-Object {
    if ($_.doNotShutdown) {
        Write-Log "  SKIP $($_.name) — tagged 'donotshutdown'."
        return $false
    }
    if (-not (Test-InWindow -TagValue $_.shutdownTime -Now $Now -WindowMinutes $WindowMinutes)) {
        return $false
    }
    return $true
}

Write-Log "$(@($toShutdown).Count) VM(s) are in the current shutdown window."

#endregion

#region ── Act (parallel REST calls — no sequential blocking) ────────────────────

$parallelResults = @($toShutdown | ForEach-Object -Parallel {
    $vm      = $_
    $token   = $using:armToken
    $whatIf  = $using:WhatIf
    $name    = $vm.name
    $rg      = $vm.resourceGroup
    $sub     = $vm.subscriptionId
    $isLocal = $vm.type -ilike '*azurestackhci*'
    $type    = if ($isLocal) { 'AzureLocal' } else { 'AzureVM' }
    $ts      = { "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')][INFO]" }

    Write-Output "$(& $ts)   $name (RG: $rg) shutdown=$($vm.shutdownTime) type=$type"

    $s = 0; $k = 0; $e = 0

    if ($isLocal) {
        if ($vm.powerState -eq 'Off' -or $vm.powerState -eq 'Stopped') {
            Write-Output "$(& $ts)     SKIP — already off (state: $($vm.powerState))."
            $k = 1
        } elseif ($whatIf) {
            Write-Output "$(& $ts)     [WHATIF] Would stop Azure Local VM: $name"
        } else {
            try {
                Invoke-RestMethod -Uri "https://management.azure.com$($vm.id)/stop?api-version=2023-09-01-preview" `
                    -Method POST -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' -ErrorAction Stop | Out-Null
                Write-Output "$(& $ts)     SUCCESS — Azure Local VM $name stop requested."
                $s = 1
            } catch {
                Write-Output "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')][ERROR]     ERROR $name — $_"
                $e = 1
            }
        }
    } else {
        if ($vm.powerState -eq 'VM deallocated') {
            Write-Output "$(& $ts)     SKIP — already deallocated."
            $k = 1
        } elseif ($whatIf) {
            Write-Output "$(& $ts)     [WHATIF] Would stop (deallocate) VM: $name"
        } else {
            try {
                Invoke-RestMethod -Uri "https://management.azure.com/subscriptions/$sub/resourceGroups/$rg/providers/Microsoft.Compute/virtualMachines/$name/deallocate?api-version=2024-03-01" `
                    -Method POST -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' -ErrorAction Stop | Out-Null
                Write-Output "$(& $ts)     SUCCESS — VM $name deallocation requested."
                $s = 1
            } catch {
                Write-Output "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')][ERROR]     ERROR $name — $_"
                $e = 1
            }
        }
    }

    [pscustomobject]@{ S = $s; K = $k; E = $e }
} -ThrottleLimit 20)

$statsObjs = $parallelResults | Where-Object { $_ -is [pscustomobject] }
$stats = @{
    ShutDown          = [int]($statsObjs | Measure-Object -Property S -Sum).Sum
    SkippedAlreadyOff = [int]($statsObjs | Measure-Object -Property K -Sum).Sum
    Errors            = [int]($statsObjs | Measure-Object -Property E -Sum).Sum
}

#endregion

#region ── Summary ──────────────────────────────────────────────────────────────

Write-Log "=============================================="
Write-Log "RUN SUMMARY  ($TimeZoneId $($Now.ToString('HH:mm')))"
Write-Log "=============================================="
Write-Log "VMs with shutdown tag    : $($allTaggedVMs.Count)"
Write-Log "VMs in window            : $(@($toShutdown).Count)"
Write-Log "VMs shut down            : $($stats.ShutDown)"
Write-Log "Skipped (already off)    : $($stats.SkippedAlreadyOff)"
Write-Log "Errors                   : $($stats.Errors)"
Write-Log "=============================================="

if ($stats.Errors -gt 0) {
    throw "Auto-Shutdown completed with $($stats.Errors) error(s). Review logs above."
}

#endregion