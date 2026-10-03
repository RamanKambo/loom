import { spawn, spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export type ExecResult =
  | { ok: true; status: number; stdout: string; stderr: string }
  | { ok: false; kind: 'missing' | 'timeout' | 'crash'; reason: string; stdout: string; stderr: string };

export interface ExecOptions {
  cwd?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

/** The first executable named `name` on PATH, honouring PATHEXT on Windows; null when absent. */
export function which(name: string): string | null {
  if (isAbsolute(name)) return existsSync(name) ? name : null;
  const exts = process.platform === 'win32' ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of ['', ...exts]) {
      const candidate = join(dir, `${name}${ext}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not in this directory
      }
    }
  }
  return null;
}

/**
 * Run an executable with a fixed argument array: no shell is involved, so no
 * argument can be reinterpreted as command text. A process still running at
 * the timeout is killed with its whole tree, because dotnet, pwsh and sqlcmd
 * spawn children that would otherwise outlive the run and hold its files.
 */
export function exec(exe: string, args: readonly string[], options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(exe, [...args], { cwd: options.cwd, env: options.env ?? process.env, windowsHide: true, shell: false });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, options.timeoutMs);
    child.stdout?.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const finish = (r: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish({ ok: false, kind: e.code === 'ENOENT' ? 'missing' : 'crash', reason: e.code === 'ENOENT' ? `${exe} was not found` : e.message, stdout, stderr }),
    );
    child.on('close', (code, signal) => {
      if (timedOut) finish({ ok: false, kind: 'timeout', reason: `${exe} did not finish within ${options.timeoutMs} ms and was stopped`, stdout, stderr });
      else if (code === null) finish({ ok: false, kind: 'crash', reason: `${exe} ended without an exit code (signal ${String(signal)})`, stdout, stderr });
      else finish({ ok: true, status: code, stdout, stderr });
    });
  });
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

/** The last line of `text` that parses as a JSON object, or null. */
export function lastJsonLine(text: string): Record<string, unknown> | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i]!) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // not JSON; keep looking upwards
    }
  }
  return null;
}

/** A PowerShell single-quoted literal. */
export const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export type PwshResult = { ok: true; json: Record<string, unknown>; stderr: string } | { ok: false; kind: 'missing' | 'timeout' | 'crash' | 'unreadable'; reason: string };

/**
 * Run a script in a fresh pwsh process and read its result from the last JSON
 * line on stdout. -EncodedCommand carries the script verbatim, so no shell
 * quoting can alter it.
 */
export async function runPwsh(pwsh: string, script: string, options: ExecOptions): Promise<PwshResult> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = await exec(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], options);
  if (!r.ok) return { ok: false, kind: r.kind, reason: r.reason };
  const json = lastJsonLine(r.stdout);
  if (!json) {
    const err = r.stderr.trim().split(/\r?\n/)[0] ?? '';
    return { ok: false, kind: 'unreadable', reason: `pwsh returned no readable result (exit ${r.status})${err ? `: ${err}` : ''}` };
  }
  return { ok: true, json, stderr: r.stderr };
}

/** The first line of a tool's output that reads like an error, for a one-line reason. */
export function firstErrorLine(text: string, pattern = /error|fail|exception/i): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => pattern.test(l)) ?? lines[lines.length - 1] ?? '').slice(0, 400);
}
