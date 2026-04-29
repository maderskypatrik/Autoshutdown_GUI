<#
.SYNOPSIS
    Daily enrollment report — emails a summary of all tagged VMs across the tenant.

.DESCRIPTION
    Runs once daily at 06:00 UTC. Uses the ARM and Resource Graph REST APIs directly
    (no Az module dependency) to find every VM with a shutdown or startup tag across
    all subscriptions, then sends a formatted HTML report via the Microsoft Graph API.

    Tokens are acquired from the managed identity endpoint — no Az modules required.

    App settings:
      REPORT_SENDER               — Shared mailbox address to send from (requires Mail.Send Graph permission)
      REPORT_RECIPIENT            — Address(es) to send the report to
      TIMEZONE                    — Windows timezone ID for display (default: UTC)
      WHATIF                      — Set to "true" to log without sending
      USER_ASSIGNED_MI_CLIENT_ID  — Client ID of the User-Assigned MI (set by New-UserAssignedMI.ps1)
#>

param($Timer)

$WhatIf     = ($env:WHATIF -eq "true")
$TimeZoneId = if ($env:TIMEZONE) { $env:TIMEZONE } else { "UTC" }
$Sender     = $env:REPORT_SENDER
$Recipient  = $env:REPORT_RECIPIENT
$Tz         = [TimeZoneInfo]::FindSystemTimeZoneById($TimeZoneId)
$Now        = [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $Tz)

#region ── Helpers ──────────────────────────────────────────────────────────────

function Write-Log {
    param ([string]$Message, [string]$Level = "INFO")
    $timestamp = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    Write-Host "[$timestamp][$Level] $Message"
}

function ConvertTo-HtmlSafe {
    param ([string]$Value)
    [System.Net.WebUtility]::HtmlEncode($Value)
}

function Get-MsiToken {
    param ([string]$Resource)
    $clientId = $env:USER_ASSIGNED_MI_CLIENT_ID
    $endpoint = if ($env:IDENTITY_ENDPOINT) { $env:IDENTITY_ENDPOINT } else { $env:MSI_ENDPOINT }
    $header   = if ($env:IDENTITY_ENDPOINT) { @{ "X-IDENTITY-HEADER" = $env:IDENTITY_HEADER } } `
                else                        { @{ "secret"             = $env:MSI_SECRET       } }
    $uri      = "${endpoint}?resource=$Resource&client_id=$clientId&api-version=2019-08-01"
    $response = Invoke-RestMethod -Uri $uri -Headers $header -ErrorAction Stop
    return $response.access_token
}

#endregion

#region ── Validation ───────────────────────────────────────────────────────────

Write-Log "Invoke-Report triggered. Local=$($Now.ToString('HH:mm')) TZ=$TimeZoneId WhatIf=$WhatIf"

if (-not $Sender)    { Write-Log "REPORT_SENDER app setting is required."    "ERROR"; throw "Missing REPORT_SENDER."    }
if (-not $Recipient) { Write-Log "REPORT_RECIPIENT app setting is required." "ERROR"; throw "Missing REPORT_RECIPIENT." }

#endregion

#region ── Tokens ───────────────────────────────────────────────────────────────

Write-Log "Acquiring tokens via Managed Identity..."
try {
    $armToken   = Get-MsiToken "https://management.azure.com/"
    $graphToken = Get-MsiToken "https://graph.microsoft.com/"
    Write-Log "Tokens acquired."
} catch {
    Write-Log "Failed to acquire MSI token: $_" "ERROR"
    throw
}

$armHeaders   = @{ Authorization = "Bearer $armToken";   "Content-Type" = "application/json" }
$graphHeaders = @{ Authorization = "Bearer $graphToken"; "Content-Type" = "application/json; charset=utf-8" }

#endregion

#region ── Subscription name map ────────────────────────────────────────────────

Write-Log "Listing subscriptions..."
try {
    $subsResponse  = Invoke-RestMethod -Uri "https://management.azure.com/subscriptions?api-version=2022-12-01" `
                        -Headers $armHeaders -ErrorAction Stop
    $subscriptions = $subsResponse.value
    Write-Log "Found $($subscriptions.Count) subscription(s) accessible to the Managed Identity."
} catch {
    Write-Log "Failed to list subscriptions: $_" "ERROR"
    throw
}

$subNames = @{}
foreach ($s in $subscriptions) { $subNames[$s.subscriptionId] = $s.displayName }

#endregion

#region ── Resource Graph query ─────────────────────────────────────────────────

$query = @"
Resources
| where type =~ 'microsoft.compute/virtualmachines'
    or type =~ 'microsoft.azurestackhci/virtualmachineinstances'
| where isnotnull(tags.shutdown) or isnotnull(tags.startup)
| project
    subscriptionId,
    name,
    resourceGroup,
    vmType        = iff(type =~ 'microsoft.compute/virtualmachines', 'Azure VM', 'Azure Local VM'),
    shutdown      = tostring(tags.shutdown),
    startup       = tostring(tags.startup),
    donotshutdown = tostring(tags.donotshutdown),
    donotstart    = tostring(tags.donotstart)
| order by subscriptionId asc, name asc
"@

Write-Log "Querying Resource Graph for enrolled VMs..."
try {
    $rgBody     = @{ query = $query; options = @{ '$top' = 1000 } } | ConvertTo-Json -Depth 3
    $rgResponse = Invoke-RestMethod `
        -Uri     "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01" `
        -Method  POST -Body $rgBody -Headers $armHeaders -ErrorAction Stop
    $allVMs = @($rgResponse.data)
    Write-Log "Found $($allVMs.Count) enrolled VM(s) across all subscriptions."
    if ($allVMs.Count -eq 1000) {
        Write-Log "Result count hit the 1000-item limit — report may be incomplete." "WARN"
    }
} catch {
    Write-Log "Resource Graph query failed: $_" "ERROR"
    throw
}

#endregion

#region ── Stats ────────────────────────────────────────────────────────────────

$grouped      = @($allVMs | Group-Object -Property subscriptionId | Sort-Object Name)
$vmCount      = $allVMs.Count
$subCount     = $grouped.Count
$shutdownOnly = @($allVMs | Where-Object {  $_.shutdown -and -not $_.startup  }).Count
$both         = @($allVMs | Where-Object {  $_.shutdown -and      $_.startup  }).Count
$excluded     = @($allVMs | Where-Object {  $_.donotshutdown -or  $_.donotstart }).Count

#endregion

#region ── HTML report ──────────────────────────────────────────────────────────

$dateStr    = $Now.ToString('dd MMMM yyyy')
$timeStr    = $Now.ToString('HH:mm')
$subjectStr = "VM Auto-shutdown Report — $dateStr — $vmCount VM$(if ($vmCount -ne 1) { 's' }) enrolled"

$cBlue        = '#0078d4'
$cDarkBlue    = '#005a9e'
$cGrey        = '#f8f8f8'
$cBorder      = '#e0e0e0'
$cAmberBg     = '#fff4ce'
$cAmberBorder = '#f0c000'
$cAmberText   = '#7d5a00'

# ── Header ───────────────────────────────────────────────────────────────────
$html  = "<!DOCTYPE html><html><head><meta charset='UTF-8'></head>"
$html += "<body style='margin:0;padding:0;background:#f0f0f0;font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1f1f1f;'>"
$html += "<table width='100%' cellpadding='0' cellspacing='0' style='background:#f0f0f0;padding:24px 0;'>"
$html += "<tr><td align='center'>"
$html += "<table width='700' cellpadding='0' cellspacing='0' style='background:#ffffff;border-radius:4px;border:1px solid $cBorder;'>"
$html += "<tr><td style='background:$cBlue;padding:24px 32px;border-radius:4px 4px 0 0;'>"
$html += "<p style='margin:0;color:#ffffff;font-size:20px;font-weight:600;'>VM Auto-shutdown &amp; Auto-startup</p>"
$html += "<p style='margin:6px 0 0;color:#cce4f7;font-size:13px;'>Daily Enrollment Report &nbsp;&middot;&nbsp; $dateStr &nbsp;&middot;&nbsp; $timeStr ($TimeZoneId)</p>"
$html += "</td></tr>"

# ── Summary block ────────────────────────────────────────────────────────────
$html += "<tr><td style='padding:24px 32px 20px;'>"
$html += "<table width='100%' cellpadding='10' cellspacing='0' style='border-collapse:collapse;border:1px solid $cBorder;'>"
$html += "<tr style='background:$cGrey;'>"
$html += "<td colspan='4' style='border:1px solid $cBorder;font-weight:600;font-size:11px;color:#555;text-transform:uppercase;letter-spacing:.5px;'>Summary</td>"
$html += "</tr>"
$html += "<tr>"
$html += "<td style='border:1px solid $cBorder;color:#555;'>Subscriptions scanned</td>"
$html += "<td style='border:1px solid $cBorder;font-weight:700;font-size:20px;color:$cBlue;'>$subCount</td>"
$html += "<td style='border:1px solid $cBorder;color:#555;'>VMs enrolled</td>"
$html += "<td style='border:1px solid $cBorder;font-weight:700;font-size:20px;color:$cBlue;'>$vmCount</td>"
$html += "</tr>"
$html += "<tr>"
$html += "<td style='border:1px solid $cBorder;color:#555;'>Shutdown + Startup</td>"
$html += "<td style='border:1px solid $cBorder;font-weight:600;'>$both</td>"
$html += "<td style='border:1px solid $cBorder;color:#555;'>Shutdown only</td>"
$html += "<td style='border:1px solid $cBorder;font-weight:600;'>$shutdownOnly</td>"
$html += "</tr>"
if ($excluded -gt 0) {
    $html += "<tr style='background:$cAmberBg;'>"
    $html += "<td style='border:1px solid $cAmberBorder;color:$cAmberText;'>&#9888;&nbsp; Excluded (donotshutdown / donotstart)</td>"
    $html += "<td style='border:1px solid $cAmberBorder;font-weight:700;color:$cAmberText;' colspan='3'>$excluded</td>"
    $html += "</tr>"
}
$html += "</table></td></tr>"

# ── Per-subscription tables ───────────────────────────────────────────────────
foreach ($group in $grouped) {

    $subId   = $group.Name
    $subName = if ($subNames.ContainsKey($subId)) { ConvertTo-HtmlSafe $subNames[$subId] } else { $subId }
    $vms     = @($group.Group | Sort-Object name)
    $vmLabel = "$($vms.Count) VM$(if ($vms.Count -ne 1) { 's' })"

    $html += "<tr><td style='padding:0 32px 24px;'>"
    $html += "<table width='100%' cellpadding='0' cellspacing='0'>"
    $html += "<tr><td style='background:$cDarkBlue;padding:9px 14px;border-radius:3px 3px 0 0;'>"
    $html += "<span style='color:#ffffff;font-size:13px;font-weight:600;'>$subName</span>"
    $html += "<span style='color:#aad4f5;font-size:12px;margin-left:10px;'>$vmLabel</span>"
    $html += "</td></tr>"
    $html += "<tr><td>"
    $html += "<table width='100%' cellpadding='0' cellspacing='0' style='border-collapse:collapse;font-size:13px;border:1px solid $cBorder;'>"
    $html += "<tr style='background:$cGrey;'>"
    $html += "<th align='left' style='border:1px solid $cBorder;padding:7px 10px;font-weight:600;color:#555;white-space:nowrap;'>VM Name</th>"
    $html += "<th align='left' style='border:1px solid $cBorder;padding:7px 10px;font-weight:600;color:#555;'>Resource Group</th>"
    $html += "<th align='left' style='border:1px solid $cBorder;padding:7px 10px;font-weight:600;color:#555;'>Shutdown</th>"
    $html += "<th align='left' style='border:1px solid $cBorder;padding:7px 10px;font-weight:600;color:#555;'>Startup</th>"
    $html += "<th align='left' style='border:1px solid $cBorder;padding:7px 10px;font-weight:600;color:#555;'>Notes</th>"
    $html += "</tr>"

    foreach ($vm in $vms) {

        $isExcluded = $vm.donotshutdown -or $vm.donotstart
        $rowBg      = if ($isExcluded) { $cAmberBg  } else { '#ffffff' }
        $rowBorder  = if ($isExcluded) { $cAmberBorder } else { $cBorder }
        $noteColor  = if ($isExcluded) { $cAmberText } else { '#888' }

        $sdCell = if ($vm.shutdown) { $vm.shutdown } else { "<span style='color:#bbb;'>&mdash;</span>" }
        $suCell = if ($vm.startup)  { $vm.startup  } else { "<span style='color:#bbb;'>&mdash;</span>" }

        $notes = @()
        if (-not $vm.startup  -and $vm.shutdown)  { $notes += 'no startup tag' }
        if (-not $vm.shutdown -and $vm.startup)   { $notes += 'no shutdown tag' }
        if ($vm.donotshutdown) { $notes += '&#9888; donotshutdown' }
        if ($vm.donotstart)    { $notes += '&#9888; donotstart' }
        $notesStr = $notes -join ' &nbsp;&middot;&nbsp; '

        $html += "<tr style='background:$rowBg;'>"
        $html += "<td style='border:1px solid $rowBorder;padding:7px 10px;font-weight:500;'>$(ConvertTo-HtmlSafe $vm.name)</td>"
        $html += "<td style='border:1px solid $rowBorder;padding:7px 10px;color:#666;'>$(ConvertTo-HtmlSafe $vm.resourceGroup)</td>"
        $html += "<td style='border:1px solid $rowBorder;padding:7px 10px;font-family:Consolas,monospace;font-size:13px;'>$sdCell</td>"
        $html += "<td style='border:1px solid $rowBorder;padding:7px 10px;font-family:Consolas,monospace;font-size:13px;'>$suCell</td>"
        $html += "<td style='border:1px solid $rowBorder;padding:7px 10px;font-size:12px;color:$noteColor;'>$notesStr</td>"
        $html += "</tr>"
    }

    $html += "</table></td></tr></table></td></tr>"
}

# ── Footer ────────────────────────────────────────────────────────────────────
$html += "<tr><td style='background:$cGrey;padding:14px 32px;border-top:1px solid $cBorder;border-radius:0 0 4px 4px;'>"
$html += "<p style='margin:0;color:#999;font-size:12px;'>PowerCloud Team &nbsp;&middot;&nbsp; func-autoshutdown &nbsp;&middot;&nbsp; Times shown in: $TimeZoneId</p>"
$html += "</td></tr>"
$html += "</table></td></tr></table></body></html>"

#endregion

#region ── Send via Microsoft Graph ─────────────────────────────────────────────

if ($WhatIf) {
    Write-Log "[WHATIF] Would send '$subjectStr' to $Recipient (from $Sender) — $vmCount VMs in $subCount subscription(s)"
} else {
    Write-Log "Sending report: '$subjectStr' to $Recipient"
    try {
        $mailBody = @{
            message        = @{
                subject      = $subjectStr
                body         = @{ contentType = "HTML"; content = $html }
                toRecipients = @(@{ emailAddress = @{ address = $Recipient } })
            }
            saveToSentItems = $false
        } | ConvertTo-Json -Depth 6

        Invoke-RestMethod `
            -Uri     "https://graph.microsoft.com/v1.0/users/$Sender/sendMail" `
            -Method  POST -Body $mailBody -Headers $graphHeaders -ErrorAction Stop | Out-Null

        Write-Log "Report sent successfully."
    } catch {
        Write-Log "Failed to send report: $_" "ERROR"
        throw
    }
}

#endregion

Write-Log "══════════════════════════════════════════════"
Write-Log "RUN SUMMARY  ($TimeZoneId $($Now.ToString('HH:mm')))"
Write-Log "══════════════════════════════════════════════"
Write-Log "Subscriptions in report  : $subCount"
Write-Log "VMs enrolled             : $vmCount"
Write-Log "  Shutdown + Startup     : $both"
Write-Log "  Shutdown only          : $shutdownOnly"
Write-Log "  Excluded               : $excluded"
Write-Log "══════════════════════════════════════════════"
