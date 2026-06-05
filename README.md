# VM Scheduler

A self-service web app that lets Azure VM owners set daily shutdown and startup schedules directly from the browser — no tickets, no scripts, no central credentials.

Schedules are stored as tags on the VMs. Each subscription gets its own **Azure Automation Account** (PowerShell 7.2 runbooks, system-assigned managed identity) that runs every 15 minutes and acts on tagged VMs. The Automation Account is installed by the user from within the app and updates itself when a new runbook version is released — no cross-subscription access, no shared secrets.

Built with React + Vite, deployed to Azure Static Web Apps, authenticated via Entra ID (MSAL.js). Users call Azure ARM APIs directly with their own token — the app has no elevated permissions of its own.

See [docs/Setup-Guide.md](docs/Setup-Guide.md) to get started.
