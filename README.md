# AD Ops — Setup

A local web app for querying Active Directory (users, groups, computers,
membership, nested membership, GPOs), deploying PowerShell scripts, and
configuring PS remoting — with markdown/text/xml/html report export.

See `DOCUMENTATION.md` for full architecture and API details.

## Prerequisites

- **Node.js 18+** (The setup script will attempt to install this via `winget` if missing).
- **Git** (Required for the deployment sync).
- **IIS (Internet Information Services)**: Required if deploying as a production web service on Windows.
- **PowerShell 5.1 or 7+** with Administrator privileges.
- Network reachability to your domain controller(s) over WinRM (ports 5985/5986).

## Deployment (Windows/IIS)

The project includes PowerShell scripts to automate deployment on Windows 10/11 using IIS as a reverse proxy and a Scheduled Task for the Node.js background process.

- **IIS port** (`-IisPort`): the public HTTP port clients use in the browser.
- **Node port** (`-NodePort`): internal port for the Node process on `localhost`; IIS proxies to it. Default is **3000** and does not need to match the IIS port.

Traffic is plain **HTTP** unless you add HTTPS/TLS bindings separately in IIS.

### Automated Setup (default: IIS port 80)

1. Open PowerShell as **Administrator**.
2. Navigate to the scripts directory:
   ```powershell
   cd server\scripts
   ```
   If you cloned the repo elsewhere, use that path (for example `cd C:\inetpub\AD-Ops\server\scripts` after a prior install).
3. Run the setup script:
   ```powershell
   .\setup-iis-win11.ps1
   ```
   *This script will:*
   - Enable IIS and required Windows features.
   - Install Node.js (via `winget`) if not found in PATH.
   - Install **IIS URL Rewrite** and **Application Request Routing (ARR)** modules.
   - Clone/Sync the repository to `C:\inetpub\AD-Ops`.
   - Install all `npm` dependencies.
   - Create a Scheduled Task (`AD-Ops-Node`) to run the backend on startup.
   - Configure an IIS site and reverse proxy on port **80** (default).
   - Create an inbound Windows Firewall rule for the IIS port.

Browse: `http://localhost` or `http://<server-ip>`.

### IIS on port 3001 (recommended when port 80 is in use)

Use this when another site already binds port 80, or you want AD-Ops on a dedicated port.

**Option A — helper script (port 3001, Node on 3000):**
```powershell
cd server\scripts
.\setup-iis-win11-port3001.ps1
```

**Option B — explicit parameters:**
```powershell
cd server\scripts
.\setup-iis-win11.ps1 -IisPort 3001 -NodePort 3000
```

Re-running either command on an existing install updates the AD-Ops site binding to port 3001 (stale HTTP bindings on that site are removed).

Browse: `http://<server-ip>:3001` (HTTP, not HTTPS, unless you configure TLS).

The setup script creates a firewall rule named `AD-Ops IIS HTTP (Port 3001)`. If you use a custom `-IisPort`, the rule name includes that port.

### Syncing Changes

To update your production instance with the latest code from the repository:
```powershell
cd C:\inetpub\AD-Ops
git pull
npm install
Restart-ScheduledTask -TaskName "AD-Ops-Node"
```

### Uninstallation

To completely remove the IIS site, app pool, scheduled task, firewall rule, and (optionally) the files:

**Default IIS port 80:**
```powershell
cd server\scripts
.\remove-iis-win11.ps1 -RemoveInstallPath
```

**If IIS was on port 3001:**
```powershell
cd server\scripts
.\remove-iis-win11.ps1 -IisPort 3001 -RemoveInstallPath
```

## Manual Installation (Development)

```bash
cd ad-ops
npm install
npm start
```

Then open `http://localhost:3000`.

## Authentication

On first run, a default local login is created:

```
username: admin
password: admin
role: admin
```

*(Note: Previous versions used a random password; it is now hardcoded to `admin` for initial setup. Change this immediately in the **Local Accounts** tab after logging in.)*


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
