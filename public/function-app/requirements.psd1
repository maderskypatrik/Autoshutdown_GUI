# NOTE: Managed dependencies are DISABLED in host.json. These modules are NOT
# installed at runtime — the CI workflow bundles them into ./Modules via
# Save-Module, and that folder ships inside the deployment zip (a root Modules
# folder is auto-added to PSModulePath). This file is kept only as the source of
# truth for the pinned versions the bundling step installs. If you re-enable
# managedDependency, remove the CI bundling step first; on Flex Consumption the
# package mount is read-only, so the two mechanisms must not be combined.
@{
    'Az.Accounts'      = '3.*'
    'Az.Compute'       = '8.*'
    'Az.ResourceGraph' = '1.*'
}