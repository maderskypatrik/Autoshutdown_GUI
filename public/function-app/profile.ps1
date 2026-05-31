# profile.ps1 runs once per PowerShell worker cold start, BEFORE the worker reports
# its functions to the Functions host.
#
# IMPORTANT: Do NOT perform synchronous, network-bound work here (e.g.
# Connect-AzAccount). On a VNet-integrated / locked-down Flex Consumption app the
# managed-identity token round-trip takes several seconds, which delays the worker
# becoming ready. If the host finishes its function-indexing pass before the worker
# is ready, it logs "No job functions found" and never registers the timer
# listeners — the functions show Enabled but never fire. So auth is done lazily on
# first invocation instead (see Connect-AutoShutdownAz below), keeping cold start fast.

if ($env:MSI_SECRET) {
    Disable-AzContextAutosave -Scope Process | Out-Null
}

# Capture root at profile load time so Invoke-VersionCheck can find version.txt
$script:_FunctionAppRoot = $PSScriptRoot

# Lazy, idempotent managed-identity sign-in. Called at the top of each function's
# run.ps1. The first invocation on a warm instance authenticates; subsequent calls
# detect the existing context and return immediately, so there is no per-run cost
# beyond the first. This keeps the blocking Connect-AzAccount off the cold-start
# critical path that gates function indexing.
function Connect-AutoShutdownAz {
    if (-not $env:MSI_SECRET) { return }   # not running in Azure (local dev)
    try {
        $ctx = Get-AzContext -ErrorAction SilentlyContinue
        if ($ctx -and $ctx.Account) { return }   # already connected on this instance
        Connect-AzAccount -Identity -AccountId $env:USER_ASSIGNED_MI_CLIENT_ID -ErrorAction Stop | Out-Null
        Write-Host "Authenticated via User-Assigned Managed Identity: $env:USER_ASSIGNED_MI_CLIENT_ID"
    } catch {
        Write-Warning "Connect-AutoShutdownAz failed: $_"
        throw
    }
}

function Invoke-VersionCheck {
    <#
    .SYNOPSIS
        Checks whether a newer version of the function app zip is available on the SWA.
        If so, restarts this Function App via the ARM API so it re-downloads the new zip.
        Returns $true if a restart was initiated (caller should return early).
    #>
    $versionFile = Join-Path $script:_FunctionAppRoot 'version.txt'
    $packageUrl  = $env:WEBSITE_RUN_FROM_PACKAGE
    $resourceId  = $env:FUNCTION_APP_RESOURCE_ID

    if (-not ($packageUrl -and $resourceId -and (Test-Path $versionFile))) { return $false }

    try {
        $currentVersion = (Get-Content $versionFile -Raw -ErrorAction Stop).Trim()
        $swaOrigin      = $packageUrl -replace '/function-app\.zip$', ''
        $latestVersion  = (Invoke-RestMethod "$swaOrigin/version.json" -TimeoutSec 10 -ErrorAction Stop).version

        if (-not $latestVersion -or $latestVersion -eq $currentVersion) { return $false }

        Write-Host "[Auto-update] New version $latestVersion available (running $currentVersion). Restarting..."
        $token = (Get-AzAccessToken -ResourceUrl 'https://management.azure.com' -ErrorAction Stop).Token
        Invoke-RestMethod `
            -Uri     "https://management.azure.com${resourceId}/restart?api-version=2023-01-01" `
            -Method  POST `
            -Headers @{ Authorization = "Bearer $token" } `
            -ErrorAction Stop | Out-Null
        Write-Host "[Auto-update] Restart initiated. This invocation will exit early."
        return $true
    } catch {
        Write-Host "[Auto-update] Version check skipped (non-fatal): $_"
        return $false
    }
}