<#
.SYNOPSIS
    Updates the VERSION app setting on all AutoShutdown Function Apps across all subscriptions.

.DESCRIPTION
    Changing any app setting causes Azure to automatically restart the Function App,
    which forces it to re-download the latest function-app.zip from WEBSITE_RUN_FROM_PACKAGE.

    Requires Azure CLI (az) logged in with an account that has Contributor or Website Contributor
    on all subscriptions containing AutoShutdown Function Apps.

.PARAMETER Version
    Version string to set (e.g. "1.1.0"). If omitted, reads from package.json.

.EXAMPLE
    ./scripts/Update-FunctionApps.ps1 -Version "1.1.0"
    ./scripts/Update-FunctionApps.ps1
#>
param(
    [string]$Version
)

# Read version from package.json if not provided
if (-not $Version) {
    $pkgPath = Join-Path $PSScriptRoot '..' 'package.json'
    $Version = (Get-Content $pkgPath -Raw | ConvertFrom-Json).version
}

Write-Host "Target version : $Version"

# Ensure resource-graph extension is available
az extension add --name resource-graph --yes --only-show-errors

# Find all AutoShutdown Function Apps across all subscriptions
Write-Host "Searching for AutoShutdown Function Apps..."
$appsJson = az graph query -q @'
Resources
| where type =~ 'microsoft.web/sites'
| where tags['autoshutdown-managed'] =~ 'v3'
| project id, name, resourceGroup, subscriptionId
'@ --query "data" -o json

$apps = @($appsJson | ConvertFrom-Json)
Write-Host "Found $($apps.Count) Function App(s)."

if ($apps.Count -eq 0) {
    Write-Host "Nothing to update."
    exit 0
}

Write-Host "Updating VERSION=$Version (10 concurrent)..."

$results = $apps | ForEach-Object -Parallel {
    $ver = $using:Version
    $out = az functionapp config appsettings set `
        --subscription $_.subscriptionId `
        --resource-group $_.resourceGroup `
        --name $_.name `
        --settings "VERSION=$ver" `
        --output none 2>&1
    if ($LASTEXITCODE -eq 0) {
        [PSCustomObject]@{ ok = $true;  msg = "  OK  $($_.name)  ($($_.subscriptionId))" }
    } else {
        [PSCustomObject]@{ ok = $false; msg = "  ERR $($_.name)  ($($_.subscriptionId)): $out" }
    }
} -ThrottleLimit 10

$errors = 0
foreach ($r in $results) {
    Write-Host $r.msg
    if (-not $r.ok) { $errors++ }
}

Write-Host ""
if ($errors -gt 0) {
    Write-Host "$errors error(s). Check output above." -ForegroundColor Red
    exit 1
}
Write-Host "All $($apps.Count) Function App(s) updated to VERSION=$Version."
Write-Host "Azure will restart each one automatically and download the new zip."
