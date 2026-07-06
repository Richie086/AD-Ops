# AD Ops — Documentation

A local web application for querying and managing Active Directory, with
markdown/text/xml/html report export. Built for a host that is **not**
domain-joined; all AD operations happen over WinRM/WMI against a target
domain controller.

---

## 1. Architecture

```
Browser (SPA, vanilla JS/HTML/CSS)
        │  fetch() JSON over HTTPS/HTTP
        ▼
Node.js / Express server  ──spawns──▶  PowerShell (pwsh/powershell.exe)
        │                                     │
        │  SQLite (local accounts,            │  Invoke-Command over WinRM
        │  saved domains)                     ▼
        ▼                              Domain Controller (or WMI-relay
   In-memory cred cache                 target for PS-remoting config)
   (per browser session, TTL)
```

**Why this shape:**
- The app host is not domain-joined, so we can't rely on local AD PowerShell
  module or Kerberos SSO. Every AD operation is a fresh `Invoke-Command
  -ComputerName <DC> -Credential <cred>` call, authenticated explicitly.
- Local login (SQLite + bcrypt) only gates access to the *tool itself*. It is
  intentionally separate from AD permissions — actual command execution is
  authorized by whatever domain credential the user supplies when they
  "Connect" to a saved domain. This matches the requirement: local auth to
  use the app, domain admin/admin rights to execute anything against AD.
- Domain admin credentials are **never written to disk**. They live only in
  an in-memory, per-session, AES-256-GCM-encrypted cache with a 30-minute
  sliding expiry (`server/credCache.js`). Logging out or session expiry wipes
  them immediately.
- Every PowerShell invocation is a fresh child process (`server/psRunner.js`)
  that receives credentials via stdin JSON (not argv, not env vars) to
  minimize exposure, and returns both structured JSON *and* the raw stdout
  text so the UI can show exactly what PowerShell printed.

## 2. Directory layout

```
ad-ops/
  package.json
  README.md                 <- setup instructions
  DOCUMENTATION.md          <- this file
  server/
    app.js                  <- Express app, session config, route mounting
    db.js                   <- SQLite schema + bootstrap (default admin acct)
    credCache.js            <- in-memory encrypted credential cache
    psRunner.js             <- spawns PowerShell, runs remote scriptblocks
    reportGen.js            <- md/txt/xml/html report generation
    middleware/auth.js      <- requireLogin gate
    routes/
      auth.js               <- login/logout/change-password
      domains.js             <- saved domains CRUD + connect/disconnect
      ad.js                  <- users/groups/computers/membership/GPO queries
      scripts.js              <- deploy/run PS scripts on target computers
      remoting.js              <- enable/disable/status WinRM via WMI relay
      reports.js               <- export query results as a file
    scripts/
      wrapper.ps1            <- stdin-JSON → Invoke-Command → stdout-JSON
  public/
    index.html
    app.js
    style.css
```

## 3. Data model (SQLite, `data/adops.db`)

| Table | Purpose |
|---|---|
| `users` | Local app login accounts (bcrypt hash) **+ `role`** (`viewer`/`operator`/`admin`). First run auto-creates `admin` (role `admin`) with a random temp password printed to console, forced change on first login. |
| `domains` | Saved domain connections: label, DC hostname, notes, last_used. No credentials stored here. |
| `audit_log` | Every login, domain connect, query, script deploy, remoting change, and account-management action — who, when, against which domain. |
| `query_history` | Every query/job's full result (`data_json`, `raw`, `command`), who ran it, against which domain, and whether it succeeded — powers the History view so results can be reopened without re-running. |

## 4. Credential & session flow

1. User logs into the app locally (`POST /api/auth/login`) → Express session cookie.
2. User picks/saves a domain (`/api/domains`), then **Connects**
   (`POST /api/domains/:id/connect`) with a domain admin username/password.
3. The server validates those credentials by running `Get-ADDomain` against
   the saved DC host. On success, the credential is encrypted and cached in
   memory, keyed by `sessionID + domainId`.
4. All subsequent AD/scripts/remoting calls for that domain reuse the cached
   credential — the browser never has to resend the password per query.
5. Cache entries expire after 30 minutes of inactivity or on logout/disconnect.

## 5. PowerShell execution model (`psRunner.js` + `wrapper.ps1`)

- Node spawns PowerShell once per API call: `pwsh -NoProfile -NonInteractive -File wrapper.ps1`.
- The JSON payload `{ DC, User, Pass, Script, Args }` is written to the
  child's **stdin**, not passed as command-line arguments (avoids leaking
  credentials via process listings).
- `wrapper.ps1` builds a `PSCredential`, turns `Script` into a `ScriptBlock`,
  and runs `Invoke-Command -ComputerName $DC -Credential $cred -ScriptBlock
  $sb -ArgumentList $Args`.
- Output is emitted after a `===JSON===` marker line so Node can cleanly
  split any incidental stdout noise from the actual `ConvertTo-Json` payload.
- Every API response includes three things, satisfying the "show raw output
  in the same window" requirement:
  - `data` — parsed JSON (rendered as a table)
  - `raw` — the literal stdout/stderr text from the PowerShell process
  - `command` — the human-readable command template that was run

- **Query values are passed as `-ArgumentList` positional parameters**, not
  string-interpolated into the script body, to avoid PowerShell injection
  from user input.

## 6. Feature → route map

| Feature | Route | Notes |
|---|---|---|
| Query users | `POST /api/ad/users` | `Get-ADUser -Filter` on Name/SamAccountName |
| Query groups | `POST /api/ad/groups` | `Get-ADGroup -Filter`, includes member count |
| Query computers | `POST /api/ad/computers` | `Get-ADComputer -Filter` |
| Direct group membership | `POST /api/ad/membership` | `Get-ADGroupMember` |
| Nested/recursive group membership | `POST /api/ad/nested-membership` | Custom recursive walk with cycle-safe de-dup, records `Depth` and `ViaGroup` path |
| Groups a user/computer belongs to | `POST /api/ad/principal-groups` | `Get-ADPrincipalGroupMembership` |
| GPO list | `POST /api/ad/gpo` | `Get-GPO -All` |
| GPO detail (XML report) | `POST /api/ad/gpo-report` | `Get-GPOReport -ReportType Xml` |
| Deploy/run PS script on hosts | `POST /api/scripts/deploy` | **operator/admin only.** Runs via `runPerTarget()` — each target isolated in its own try/catch, so one bad host can't sink the batch. Returns `[{Target, Success, Output, Error}]`. |
| Configure PS remoting | `POST /api/remoting/configure` | **operator/admin only.** Relayed via DC using WMI (`Invoke-WmiMethod` → `Win32_Process.Create`) so it works even where WinRM isn't enabled yet on the target |
| Save/list/delete domains | `/api/domains` (GET/POST/DELETE) | GET is open to all roles; POST/DELETE require operator/admin |
| Connect/disconnect domain session | `/api/domains/:id/connect` \| `/disconnect` | Open to all roles — authorization comes from the domain credential itself |
| Export report | `POST /api/reports/export` | Returns a downloadable md/txt/xml/html file built from the last query's `data` |
| Job/query history | `GET /api/history` \| `GET /api/history/:id` | Own history for all roles; admins can pass `?all=1` to see everyone's. Fetching a single record returns the original `data`/`raw`/`command` so a past result can be reopened without re-running it. |
| Local account management | `/api/users` (GET/POST/PATCH/DELETE) | **admin only.** Create/delete accounts, change role, force a password reset. Refuses to delete/demote the last remaining admin or delete your own account. |

## 7. Role-based access

Three roles, stored per local account (`users.role`), checked both server-
side (`requireRole()` middleware) and reflected in the UI (nav items/forms
hide via a `role-gated` / `data-min-role` attribute pair in `app.js`):

| Role | Can do |
|---|---|
| `viewer` | Run all read-only AD queries (users/groups/computers/membership/nested/principal-groups/GPO), connect to saved domains with their own credentials, view/export their own results, view their own job history |
| `operator` | Everything `viewer` can, **plus**: add/delete saved domains, deploy/run PowerShell scripts on targets, configure PS remoting |
| `admin` | Everything `operator` can, **plus**: manage local accounts (create, delete, change role, force password reset), view *everyone's* job history (`?all=1`) |

The first-run bootstrap account is `admin`/role `admin`. Guardrails: the
API refuses to delete or demote the last remaining `admin` account, and
refuses to let an account delete itself.

Enforcement is server-side first — the UI hiding is a convenience, not the
security boundary. `/api/scripts` and `/api/remoting` are gated with
`requireRole(['operator','admin'])` at the router-mount level in `app.js`;
`/api/domains` gates POST/DELETE per-route inside `domains.js` (GET stays
open to all roles since read-only domain listing is harmless); `/api/users`
is gated `admin`-only at mount time.

## 8. Job / query history

Every AD query, script deployment, and remoting change is recorded to
`query_history` (via `recordHistory()` in `db.js`) — including failed runs,
so "what did I try yesterday and why did it fail" is answerable without
re-running anything.

- `GET /api/history` returns a lightweight list (title, domain, success,
  timestamp) — own history by default, or everyone's for admins passing
  `?all=1`.
- `GET /api/history/:id` returns the full stored record — `data`, `raw`,
  and `command` exactly as they were at the time — which the frontend feeds
  straight into the normal results renderer. Clicking a history row is
  indistinguishable from just having run the query, except nothing is
  re-executed against AD.
- Non-admins can only fetch their own records by ID even if they guess
  another user's history ID (checked in `getHistoryRecord()`).

## 9. Per-target script deployment

The original `Deploy Script` implementation ran a single `Invoke-Command
-ComputerName <targets>` call, which has a sharp edge: by default that
fans out to every target, but our wrapper set `$ErrorActionPreference =
'Stop'` and `-ErrorAction Stop`, so **one unreachable or erroring host
aborted the entire batch** — including hosts that would otherwise have
succeeded.

Fixed via a dedicated `Mode: "perTarget"` path (`wrapper.ps1` +
`psRunner.runPerTarget()`): the wrapper loops over targets itself, wrapping
each `Invoke-Command` in its own try/catch, and always returns an array of

```json
{ "Target": "WKS-01", "Success": true,  "Output": "...", "Error": null }
{ "Target": "WKS-02", "Success": false, "Output": null,  "Error": "..." }
```

so partial failures are visible per host instead of losing the whole run.
The frontend's generic table renderer highlights the `Success` column
(✅/❌) automatically. The route (`/api/scripts/deploy`) records the
deployment to history with a summary like `(2/3 succeeded)` and marks the
overall run successful only if every target succeeded.

## 10. Report generation (`reportGen.js`)

Given any query's `data` (array of objects) it can render:
- **Markdown** — GitHub-style table
- **Text** — fixed-width padded columns
- **XML** — `<Report><Results><Item>...</Item></Results></Report>`
- **HTML** — standalone styled page with a sortable-looking table

All four share the same column-discovery logic so exports stay consistent
with whatever the query returned.

## 11. Frontend

Single-page vanilla JS/HTML/CSS app (`public/index.html`, `app.js`,
`style.css`) — no build step, so it's trivial to run and modify.

- **Login → change-password (first run) → main app**, gated purely by
  session cookie checks against `/api/auth/me`.
- **Top bar**: saved-domain dropdown, Connect button (prompts for domain
  admin username/password, calls `/api/domains/:id/connect`), a live
  connected/not-connected indicator, and logout.
- **Sidebar nav** (collapses to a slide-out drawer under 820px width):
  Users, Groups, Computers, Group Membership, Nested Membership, User's
  Groups, Group Policy, Deploy Script, PS Remoting, Saved Domains.
- Every query view is a small form wired generically: forms carry
  `data-endpoint` and `data-body` attributes, and a single delegated handler
  (`runQuery()` in `app.js`) posts to the right route and renders the
  response — no per-view boilerplate needed for the straightforward CRUD-y
  queries (users/groups/computers/membership/nested/principal-groups/GPO).
  Deploy Script and PS Remoting have their own small handlers since they
  take different shaped payloads (targets array, action enum).
- **Results area** (shared across all views): an auto-generated HTML table
  from whatever columns came back, an **Export** row (md/txt/xml/html —
  hits `/api/reports/export` and downloads a blob), and a collapsible **raw
  output** panel showing the literal PowerShell stdout/stderr plus the
  command template that was run — satisfying the "show raw output in the
  same window" requirement for every query type.
- Responsive via CSS flexbox/grid + a single breakpoint (820px) that turns
  the fixed sidebar into an overlay drawer toggled by a hamburger button.

## 12. Security notes / assumptions

- Assumes PowerShell (with WinRM/AD/GroupPolicy remoting capability) is
  already installed on the host running this app, per user confirmation.
- Assumes target DC and any script-deploy targets have WinRM listening and
  reachable (5985/5986) for normal queries; the remoting-configure feature
  uses WMI (port 135 + RPC) specifically to bootstrap WinRM where it isn't
  enabled yet.
- Local login is a access gate for the tool, not an AD trust boundary — real
  authorization comes from the domain credential supplied at Connect time.
- Script deployment executes arbitrary PowerShell with whatever rights the
  connected credential has. Treat this like any other privileged remote-exec
  tool: restrict who has local logins, and know what you're pasting in.
- No credentials are ever persisted to disk or written to the audit log.

## 13. Build status

All planned features are implemented and pass a Node syntax check:

- [x] Local auth (bootstrap admin account, forced password change, sessions)
- [x] Role-based access (viewer/operator/admin) enforced server-side and reflected in the UI
- [x] Saved domains (CRUD) + live-validated connect/disconnect with in-memory credential cache
- [x] Query users / groups / computers
- [x] Direct group membership
- [x] Recursive/nested group membership (cycle-safe)
- [x] Reverse lookup: groups a user/computer belongs to
- [x] GPO listing + per-GPO XML report
- [x] Deploy/run arbitrary PowerShell against target computers, **with isolated per-target pass/fail results**
- [x] Configure (enable/disable/status) PS remoting on a target via WMI relay
- [x] Markdown / text / XML / HTML report export
- [x] Raw PowerShell output + command template shown alongside every result
- [x] Job/query history per user, viewable without re-running (admins can see everyone's)
- [x] Local account management (admin-only): create, delete, change role, force password reset
- [x] Responsive UI (desktop sidebar, mobile drawer)
- [x] Audit logging of logins, connects, queries, deploys, remoting changes, and account management

**Not yet done / left for you to verify in your environment** (couldn't be
tested here — this sandbox has no Windows host, AD, or network egress):
- Actual `npm install` and a live run against a real DC
- Real-world Kerberos/NTLM auth negotiation nuances for your specific AD setup
- Whatever WinRM TrustedHosts/certificate config your environment needs for
  the app host (non-domain-joined) to authenticate to the DC

## 14. Setup

See `README.md` for install/run steps. Summary: `npm install`, `npm start`,
browse to `http://localhost:3000`, note the temp admin password printed to
the console on first run.
