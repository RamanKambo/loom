import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { ProviderConfiguration } from '@loom/core';
import { exec, runPwsh, psq, which } from './exec.js';
import { acquireLease, providerConfigurationPath } from './lifecycle.js';

export type ProviderEntry = ProviderConfiguration['providers'][number];
export function readProviderConfiguration(file = providerConfigurationPath()): ProviderConfiguration | null {
  if (!existsSync(file)) return null;
  const value = JSON.parse(readFileSync(file, 'utf8')) as ProviderConfiguration;
  if (value.providersVersion !== 1 || !Array.isArray(value.providers) || !value.providers.length) throw new Error('invalid trusted provider configuration');
  const ids = new Set<string>();
  for (const provider of value.providers) {
    if (!/^[A-Za-z0-9._-]+$/.test(provider.id) || ids.has(provider.id)) throw new Error('invalid or duplicate provider id'); ids.add(provider.id);
    if (provider.kind === 'localdb') { if (!/^\d+\.\d+(?:\.\d+)*$/.test(provider.version) || !existsSync(provider.executable)) throw new Error('unprovisioned LocalDB executable or engine version'); }
    else if (provider.kind !== 'developer-service' || !/^(?:MSSQLSERVER|MSSQL\$[A-Za-z0-9_]+)$/.test(provider.serviceName) || !/^[A-Za-z0-9_]+$/.test(provider.instanceName) || typeof provider.startupChangeAuthorized !== 'boolean') throw new Error('invalid dedicated service provider');
  }
  return value;
}
export interface ServiceSnapshot { name: string; state: 'Stopped' | 'Running' | 'Other'; startup: 'Manual' | 'Disabled' | 'Automatic'; edition: string; canControl: boolean; }
export interface ServiceController {
  inspect(name: string): Promise<ServiceSnapshot | null>;
  startup(name: string, mode: ServiceSnapshot['startup']): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
}
export type ServiceAcquisition = { ok: true; server: string; restore: () => Promise<void>; original: ServiceSnapshot } | { ok: false; cause: 'provider-blocked'; reason: string };

/** Decision logic is injectable; a fake controller proves refusal, never native SQL capability. */
export async function acquireDeveloperService(entry: Extract<ProviderEntry, { kind: 'developer-service' }>, controller: ServiceController): Promise<ServiceAcquisition> {
  const original = await controller.inspect(entry.serviceName);
  if (!original || original.name !== entry.serviceName || !/Developer/i.test(original.edition) || !original.canControl || original.state !== 'Stopped' || original.startup === 'Automatic' || (original.startup === 'Disabled' && !entry.startupChangeAuthorized)) return { ok: false, cause: 'provider-blocked', reason: 'dedicated Developer service must be stopped, controllable and Manual, or explicitly authorized Disabled; no service mutation was performed' };
  let changed = false;
  const restore = async () => { await controller.stop(entry.serviceName); const stopped = await controller.inspect(entry.serviceName); if (!stopped || stopped.state !== 'Stopped') throw new Error('dedicated service stop unverified'); if (changed) await controller.startup(entry.serviceName, original.startup); const restored = await controller.inspect(entry.serviceName); if (!restored || restored.startup !== original.startup) throw new Error('dedicated service startup restoration unverified'); };
  try {
    if (original.startup === 'Disabled') { await controller.startup(entry.serviceName, 'Manual'); changed = true; }
    await controller.start(entry.serviceName);
    const running = await controller.inspect(entry.serviceName);
    if (!running || running.state !== 'Running') throw new Error('dedicated service start unverified');
    return { ok: true, server: entry.instanceName === 'MSSQLSERVER' ? hostname() : `${hostname()}\\${entry.instanceName}`, restore, original };
  } catch (e) { try { await restore(); } catch (restoreError) { throw new Error(`service acquisition failed: ${String(e)}; restoration failed: ${String(restoreError)}`); } return { ok: false, cause: 'provider-blocked', reason: String(e) }; }
}

export function windowsServiceController(timeoutMs = 60_000): ServiceController {
  const executable = which('powershell.exe');
  if (!executable) throw new Error('Windows PowerShell service controller is unavailable');
  const command = async (script: string): Promise<void> => { const r = await exec(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'; ${script}`, 'utf16le').toString('base64')], { timeoutMs }); if (!r.ok || r.status !== 0) throw new Error(r.ok ? r.stderr : r.reason); };
  return {
    inspect: async (name) => {
      const r = await runPwsh(executable, [
        `$s=Get-CimInstance Win32_Service -Filter ${psq(`Name='${name.replace(/'/g, "''")}'`)}; if (!$s) { @{ absent=$true } | ConvertTo-Json -Compress; exit };`,
        // Check the installed edition from registry before starting any service.
        `$instance=if (${psq(name)} -eq 'MSSQLSERVER') {'MSSQLSERVER'} else { ${psq(name)}.Substring(6) };`,
        "$map=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\Instance Names\\SQL' -ErrorAction SilentlyContinue; $id=$map.$instance; $edition=if ($id) {(Get-ItemProperty ('HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\'+$id+'\\Setup') -ErrorAction SilentlyContinue).Edition} else {''};",
        "$mode=switch($s.StartMode){'Auto' {'Automatic'} 'Disabled' {'Disabled'} default {'Manual'}};",
        // Service DACL control is checked through sc sdshow; no elevation is requested.
        "$admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);",
        `[pscustomobject]@{name=$s.Name;state=$s.State;startup=$mode;edition=[string]$edition;canControl=$admin} | ConvertTo-Json -Compress`,
      ].join('\n'), { timeoutMs });
      if (!r.ok || r.json['absent']) return null;
      return r.json as unknown as ServiceSnapshot;
    },
    startup: (name, mode) => command(`Set-Service -Name ${psq(name)} -StartupType ${mode}`),
    start: (name) => command(`Start-Service -Name ${psq(name)}`),
    stop: (name) => command(`Stop-Service -Name ${psq(name)}; (Get-Service -Name ${psq(name)}).WaitForStatus('Stopped', [TimeSpan]::FromMilliseconds(${timeoutMs}))`),
  };
}

/** Provision a common machine root with OS ACLs before using a service across users. */
export const acquireMachineLease = (root: string, runId: string, signal?: AbortSignal, deadlineMs?: number): Promise<() => void> => acquireLease(root, runId, signal, deadlineMs);
