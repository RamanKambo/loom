import { psq } from './exec.js';

/** Trusted Windows launcher: assign the native renderer to a memory-limited, kill-on-close Job Object before feeding its input. */
export function windowsRendererScript(executable: string, args: readonly string[], memoryBytes: number): string {
  const source = `
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
public static class LoomRendererJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long PerProcessTime, PerJobTime; public uint Flags; public UIntPtr MinimumWorkingSet, MaximumWorkingSet; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct Limits { public Basic Basic; public Io Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attr, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int type, IntPtr info, uint bytes);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int Run(string exe, string[] args, ulong memory) {
    var job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("Cannot allocate renderer Job Object");
    IntPtr info = IntPtr.Zero;
    Process process = null;
    try {
      var limits = new Limits(); limits.Basic.Flags = 0x100 | 0x2000; limits.ProcessMemoryLimit = new UIntPtr(memory);
      int size = Marshal.SizeOf(typeof(Limits)); info = Marshal.AllocHGlobal(size); Marshal.StructureToPtr(limits, info, false);
      if (!SetInformationJobObject(job, 9, info, (uint)size)) throw new Exception("Cannot enforce renderer memory limit");
      var start = new ProcessStartInfo(exe); start.UseShellExecute = false; start.CreateNoWindow = true;
      start.RedirectStandardInput = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
      foreach (var arg in args) start.ArgumentList.Add(arg);
      process = Process.Start(start);
      if (!AssignProcessToJobObject(job, process.Handle)) { process.Kill(true); throw new Exception("Cannot assign renderer to memory-limited job"); }
      var output = process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
      var errors = process.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
      Console.OpenStandardInput().CopyTo(process.StandardInput.BaseStream); process.StandardInput.Close();
      process.WaitForExit(); Task.WaitAll(output, errors); return process.ExitCode;
    } finally { if (info != IntPtr.Zero) Marshal.FreeHGlobal(info); CloseHandle(job); if (process != null) process.Dispose(); }
  }
}`;
  return [`$ErrorActionPreference = 'Stop'`, `Add-Type -TypeDefinition ${psq(source)}`, `$code = [LoomRendererJob]::Run(${psq(executable)}, [string[]]@(${args.map(psq).join(', ')}), [ulong]${memoryBytes})`, 'exit $code'].join('\n');
}
