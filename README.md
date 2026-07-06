# AD Ops — Setup

A local web app for querying Active Directory (users, groups, computers,
membership, nested membership, GPOs), deploying PowerShell scripts, and
configuring PS remoting — with markdown/text/xml/html report export.

See `DOCUMENTATION.md` for full architecture and API details.

## Prerequisites

- Node.js 18+
- PowerShell installed on this host (assumed already present per your setup — either
  Windows PowerShell or PowerShell 7/`pwsh`), with network reachability to
  your domain controller(s) over WinRM (ports 5985/5986) and, for the
  PS-remoting-configure feature, WMI/RPC (port 135 + dynamic range) to any
  target computers.
- A domain account with rights to run the AD/GroupPolicy cmdlets you intend
  to use (domain admin, or a delegated account with equivalent read/exec rights).
- This host does **not** need to be domain-joined. It reaches AD purely
  through `Invoke-Command` against a domain controller you specify.

## Install

```bash
cd ad-ops
npm install
```

## Run

```bash
npm start
```

Then open `http://localhost:3000`.

On first run, a default local login is created:

```
username: admin
password: <a random temporary password printed in the console>
role: admin
```

You'll be forced to set a new password on first login. This local account
only gates access to the web UI — it has nothing to do with AD permissions.

### Roles

| Role | Can do |
|---|---|
| `viewer` | Run all read-only AD queries, connect to saved domains with their own creds, view their own job history |
| `operator` | Everything a viewer can, plus: manage saved domains, deploy scripts, configure PS remoting |
| `admin` | Everything an operator can, plus: manage local accounts, view everyone's job history |

As an `admin`, go to **Local Accounts** to create logins for your team.
New accounts get a random temporary password (shown once, in the UI) and
must change it on first login — same as the bootstrap `admin` account.

## Using it

1. **Saved Domains** tab → add a domain (label + DC hostname/IP).
2. Top bar → select that domain → **Connect** → enter your domain admin
   username/password. This is validated live against the DC and cached in
   server memory for your session only (30 min sliding expiry, never
   written to disk).
3. Use the sidebar to run queries. Every result shows a table plus the raw
   PowerShell output in a collapsible panel below it.
4. Use the **Export** buttons to download the current result as
   `.md`, `.txt`, `.xml`, or `.html`.

## Configuration

Environment variables (optional):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `SESSION_SECRET` | random per-start | Express session signing secret. Set this explicitly if running multiple instances behind a load balancer. |
| `PS_BIN` | `pwsh` (or `powershell.exe` on Windows) | Override which PowerShell binary to invoke |

## Notes

- Run this behind HTTPS (e.g. a reverse proxy) in any environment beyond
  localhost testing — session cookies and the login form are not encrypted
  in transit otherwise.
- The SQLite database lives at `data/adops.db` and holds local accounts,
  saved domain labels/hostnames, and an audit log — never domain credentials.

## Windows IIS Deployment Scripts

The repository includes Windows 11 helper scripts for IIS-based deployment and cleanup:

- `server/scripts/setup-iis-win11.ps1`: Enables IIS features, clones/updates this repo,
  installs Node dependencies, creates a startup scheduled task for `npm start`, waits for
  the Node listener, and configures IIS reverse proxy rules to `localhost:<NodePort>`.
- `server/scripts/remove-iis-win11.ps1`: Removes the scheduled task, stops listeners on
  the configured Node port, removes IIS site/app pool, and optionally removes the install
  directory.

Example setup:

```powershell
powershell -ExecutionPolicy Bypass -File .\server\scripts\setup-iis-win11.ps1 -IisPort 80 -NodePort 3000
```

Example teardown:

```powershell
powershell -ExecutionPolicy Bypass -File .\server\scripts\remove-iis-win11.ps1 -RemoveInstallPath
```

## Documentation Upkeep

When repository behavior changes, update this README in the same PR/commit. Minimum checklist:

- Update prerequisites when runtime or OS assumptions change.
- Update configuration variables and default values.
- Update script usage examples when script parameters or behavior change.
- Add a short note for new endpoints, major features, or operational workflows.
