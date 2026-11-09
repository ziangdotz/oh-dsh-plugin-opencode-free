// Windows process-tree owner. Closing the DSH pipe closes the Job Object,
// including when DSH is killed without running JavaScript exit handlers.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

class ServerOwner {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int info, ref ExtendedLimits limits, int size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static string Quote(string value) {
    var result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char ch in value) {
      if (ch == '\\') { slashes++; continue; }
      if (ch == '"') result.Append('\\', slashes * 2 + 1);
      else result.Append('\\', slashes);
      result.Append(ch);
      slashes = 0;
    }
    result.Append('\\', slashes * 2);
    return result.Append('"').ToString();
  }
  static int Main(string[] args) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return 70;
    try {
      var limits = new ExtendedLimits();
      limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)) ||
          !AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle)) return 71;
      // Assign the owner before starting anything: even a detaching launcher
      // cannot escape the job or race assignment of its descendants.
      var command = new StringBuilder();
      for (int i = 1; i < args.Length; i++) command.Append(Quote(args[i])).Append(' ');
      var start = new ProcessStartInfo(args[0], command.ToString());
      start.UseShellExecute = false;
      start.CreateNoWindow = true;
      using (var launcher = Process.Start(start)) {
        // A launcher can exit before its server; pipe lifetime owns the job.
        Console.In.ReadToEnd();
      }
      return 0;
    } catch (Exception error) {
      Console.Error.WriteLine(error.Message);
      return 72;
    } finally { CloseHandle(job); }
  }
}
