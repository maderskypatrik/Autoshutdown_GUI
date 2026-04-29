# profile.ps1 runs once per Function host cold start.
# $env:MSI_SECRET is set by Azure when running inside a Function App — absent during local dev.
if ($env:MSI_SECRET) {
    Disable-AzContextAutosave -Scope Process | Out-Null
    # USER_ASSIGNED_MI_CLIENT_ID is set as a Function App application setting by the installer
    Connect-AzAccount -Identity -AccountId $env:USER_ASSIGNED_MI_CLIENT_ID -ErrorAction Stop | Out-Null
    Write-Host "Authenticated via User-Assigned Managed Identity: $env:USER_ASSIGNED_MI_CLIENT_ID"
}
