# profile.ps1 runs once per Function host cold start.
# $env:MSI_SECRET is set by Azure when running inside a Function App — absent during local dev.
if ($env:MSI_SECRET) {
    Disable-AzContextAutosave -Scope Process | Out-Null
    # USER_ASSIGNED_MI_CLIENT_ID is set as a Function App application setting by the installer
    Connect-AzAccount -Identity -AccountId $env:USER_ASSIGNED_MI_CLIENT_ID -ErrorAction Stop | Out-Null
    Write-Host "Authenticated via User-Assigned Managed Identity: $env:USER_ASSIGNED_MI_CLIENT_ID"
}

# Capture root at profile load time so Invoke-VersionCheck can find version.txt
$script:_FunctionAppRoot = $PSScriptRoot

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
