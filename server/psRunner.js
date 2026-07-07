const { spawn } = require('child_process');
const path = require('path');

const WRAPPER_PATH = path.join(__dirname, 'scripts', 'wrapper.ps1');

// Resolve which PowerShell binary to use. Prefer PowerShell 7+ (pwsh) if
// present on PATH; fall back to Windows PowerShell. Set PS_BIN env var to
// override explicitly.
const PS_BIN = process.env.PS_BIN || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');

// Shared low-level call: spawn the wrapper, feed it JSON on stdin, split
// the ===JSON=== marker out of stdout, and resolve a normalized result.
function invokeWrapper(payload, commandForDisplay) {
  return new Promise((resolve) => {
    const proc = spawn(
      PS_BIN,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WRAPPER_PATH],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('error', (err) => {
      resolve({
        ok: false,
        data: null,
        raw: stderr,
        command: commandForDisplay,
        error: `Failed to launch ${PS_BIN}: ${err.message}. Is PowerShell installed and on PATH?`,
      });
    });

    proc.on('close', (code) => {
      const marker = '===JSON===';
      let data = null;
      let parseError = null;

      const idx = stdout.lastIndexOf(marker);
      if (idx !== -1) {
        let jsonText = stdout.slice(idx + marker.length).replace(/^\uFEFF/, '').trim();
        // WinRM/CLIXML noise can land after the marker; grab the first JSON value.
        const jsonStart = jsonText.search(/[\[{]/);
        if (jsonStart > 0) jsonText = jsonText.slice(jsonStart);
        try {
          data = jsonText ? JSON.parse(jsonText) : [];
        } catch (e) {
          parseError = 'Could not parse JSON output: ' + e.message;
        }
      } else {
        parseError = 'No structured output returned; see raw output.';
      }

      const rawCombined = [stdout, stderr].filter(Boolean).join('\n---STDERR---\n');

      if (parseError) {
        resolve({ ok: false, data: null, raw: rawCombined, command: commandForDisplay, error: parseError });
      } else if (code !== 0 && data && data.error) {
        resolve({ ok: false, data: null, raw: rawCombined, command: commandForDisplay, error: data.message });
      } else if (code !== 0) {
        resolve({ ok: false, data: null, raw: rawCombined, command: commandForDisplay, error: stderr || 'PowerShell exited with an error.' });
      } else {
        resolve({ ok: true, data, raw: rawCombined, command: commandForDisplay });
      }
    });

    proc.stdin.write(payload);
    proc.stdin.end();
  });
}

/**
 * Run a scriptblock body on a remote host (or hosts) via Invoke-Command
 * (WinRM). If any target in a multi-host call fails, the ENTIRE call fails
 * — use runPerTarget() instead when you need isolated per-host results.
 * @param {string|string[]} dcHost - target hostname/IP(s)
 * @param {string} username - e.g. CONTOSO\\admin or admin@contoso.com
 * @param {string} password - plaintext, used only for this single process invocation
 * @param {string} scriptBody - PowerShell scriptblock body, e.g. "param($f) Get-ADUser -Filter $f"
 * @param {any[]} args - positional arguments passed into the scriptblock
 * @returns {Promise<{ok: boolean, data: any, raw: string, command: string, error?: string}>}
 */
function runRemote(dcHost, username, password, scriptBody, args = [], options = {}) {
  const useSsl = !!options.useSsl;
  const payload = JSON.stringify({
    DC: dcHost,
    User: username,
    Pass: password,
    Script: scriptBody,
    Args: args,
    UseSSL: useSsl,
  });

  const transport = useSsl ? ' -UseSSL -Port 5986' : '';
  const commandForDisplay =
    `Invoke-Command -ComputerName ${dcHost}${transport} -Credential ${username} -ScriptBlock { ${scriptBody} }` +
    (args.length ? ` -ArgumentList ${JSON.stringify(args)}` : '');

  return invokeWrapper(payload, commandForDisplay);
}

/**
 * Run a scriptblock on each target independently, isolating failures so
 * one unreachable/erroring host doesn't abort the others. Always resolves
 * ok:true (transport-level failure to launch PowerShell itself is the only
 * thing that sets ok:false) — check each item's `Success` field for the
 * per-host outcome.
 * @param {string[]} targets
 * @param {string} username
 * @param {string} password
 * @param {string} scriptBody
 * @returns {Promise<{ok: boolean, data: {Target:string, Success:boolean, Output:string|null, Error:string|null}[], raw: string, command: string}>}
 */
function runPerTarget(targets, username, password, scriptBody, options = {}) {
  const useSsl = !!options.useSsl;
  const payload = JSON.stringify({
    Mode: 'perTarget',
    Targets: targets,
    User: username,
    Pass: password,
    Script: scriptBody,
    UseSSL: useSsl,
  });

  const transport = useSsl ? ' -UseSSL -Port 5986' : '';
  const commandForDisplay =
    `foreach ($t in ${JSON.stringify(targets)}) { Invoke-Command -ComputerName $t${transport} -Credential ${username} -ScriptBlock { ${scriptBody} } }`;

  return invokeWrapper(payload, commandForDisplay);
}

/**
 * Escape a value for safe embedding inside a single-quoted PowerShell string
 * literal. Only used for cosmetic/display strings — actual query values
 * should be passed through the Args mechanism above, not interpolated.
 */
function psEscapeLiteral(str) {
  return String(str).replace(/'/g, "''");
}

module.exports = { runRemote, runPerTarget, psEscapeLiteral };
