# Dot-source from Windows PowerShell 5.1. Add-Type emits no pipeline output.
if (-not ('GoyMusic.GroupTrialLauncher' -as [type])) {
    Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace GoyMusic {
    public static class GroupTrialLauncher {
        const uint CREATE_SUSPENDED = 0x4, STARTF_TITLEISAPPID = 0x1000;
        const uint JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x800;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct StartupInfo {
            public int cb;
            public IntPtr reserved, desktop;
            public string title;
            public uint x, y, width, height, charsX, charsY, fill, flags;
            public ushort showWindow, reserved2Size;
            public IntPtr reserved2, stdin, stdout, stderr;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct ProcessInfo {
            public IntPtr process, thread;
            public int pid, tid;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimits {
            public long processTime, jobTime;
            public uint flags;
            public UIntPtr minWorkingSet, maxWorkingSet;
            public uint activeProcesses;
            public UIntPtr affinity;
            public uint priorityClass, schedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimits {
            public BasicLimits basic;
            public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
            public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        static extern bool CreateProcessW(string application, StringBuilder commandLine,
            IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
            IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo info);
        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, int size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")]
        static extern IntPtr GetCurrentProcess();
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int size, out int used);

        static Win32Exception Failure(string operation) {
            int error = Marshal.GetLastWin32Error();
            return new Win32Exception(error, operation + ": " + new Win32Exception(error).Message);
        }
        static void RequireUnelevated(IntPtr process) {
            IntPtr token;
            if (!OpenProcessToken(process, 8 /* TOKEN_QUERY */, out token)) throw Failure("OpenProcessToken");
            try {
                int elevated, used;
                if (!GetTokenInformation(token, 20 /* TokenElevation */, out elevated, sizeof(int), out used))
                    throw Failure("GetTokenInformation");
                if (elevated != 0) throw new InvalidOperationException("Run the group trial without administrator privileges.");
            } finally { CloseHandle(token); }
        }
        public static void RequireUnelevated() { RequireUnelevated(GetCurrentProcess()); }

        static string FullPath(string path) {
            if (String.IsNullOrEmpty(path) || path.IndexOf('"') >= 0) throw new ArgumentException("Expected an absolute file system path.");
            string root = Path.GetPathRoot(path);
            if (String.IsNullOrEmpty(root) || root == @"\" || root.EndsWith(":") || root.StartsWith(@"\\?\") || root.StartsWith(@"\\.\"))
                throw new ArgumentException("Expected an absolute drive or UNC path.");
            return Path.GetFullPath(path);
        }
        public static Process Start(string exe, string profile, string mode) {
            RequireUnelevated();
            bool appId = mode == "appid" || mode == "both", inJob = mode == "job" || mode == "both";
            if (!appId && !inJob && mode != "plain") throw new ArgumentException("Unknown trial mode.");
            exe = FullPath(exe);
            if (!String.Equals(Path.GetFileName(exe), "GoyMusic.exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(exe))
                throw new ArgumentException("An existing, installed GoyMusic.exe is required.");
            string directory = Path.GetDirectoryName(exe);
            var command = new StringBuilder().Append('"').Append(exe).Append('"');
            if (!String.IsNullOrEmpty(profile)) {
                profile = FullPath(profile).TrimEnd('\\');
                if (profile.Length <= Path.GetPathRoot(profile).Length || File.Exists(profile) ||
                    (profile + @"\").StartsWith(directory.TrimEnd('\\') + @"\", StringComparison.OrdinalIgnoreCase))
                    throw new ArgumentException("Use a separate trial profile directory outside the installation.");
                if (Directory.Exists(profile)) {
                    using (var entries = Directory.EnumerateFileSystemEntries(profile).GetEnumerator()) {
                        if (entries.MoveNext()) throw new ArgumentException("Use a new or empty trial profile directory.");
                    }
                }
                command.Append(" \"--user-data-dir=").Append(profile).Append('"');
            }
            var startup = new StartupInfo();
            startup.cb = Marshal.SizeOf(typeof(StartupInfo));
            if (appId) { startup.flags = STARTF_TITLEISAPPID; startup.title = "com.goymusic.app"; }

            IntPtr job = IntPtr.Zero;
            try {
                if (inJob) {
                    job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
                    if (job == IntPtr.Zero) throw Failure("CreateJobObjectW");
                    var limits = new ExtendedLimits();
                    // Default: descendants join the job. Explicit breakaway by Chromium/updater remains possible.
                    // No silent breakaway, kill-on-close, resource or UI limits.
                    limits.basic.flags = JOB_OBJECT_LIMIT_BREAKAWAY_OK;
                    if (!SetInformationJobObject(job, 9 /* JobObjectExtendedLimitInformation */, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))))
                        throw Failure("SetInformationJobObject");
                }
                ProcessInfo pi;
                if (!CreateProcessW(exe, command, IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED,
                                    IntPtr.Zero, directory, ref startup, out pi)) throw Failure("CreateProcessW");
                Process player = null;
                bool resumed = false;
                try {
                    // Acquire the returned Process object's own durable handle BEFORE the child can exit or its PID can be reused.
                    player = Process.GetProcessById(pi.pid);
                    RequireUnelevated(player.Handle);
                    if (inJob && !AssignProcessToJobObject(job, pi.process)) throw Failure("AssignProcessToJobObject");
                    if (ResumeThread(pi.thread) == UInt32.MaxValue) throw Failure("ResumeThread");
                    resumed = true;
                    return player;
                } finally {
                    if (!resumed) {
                        TerminateProcess(pi.process, 1); // Only our own never-resumed root, by its creation handle.
                        if (player != null) player.Dispose();
                    }
                    CloseHandle(pi.thread);
                    CloseHandle(pi.process);
                }
            } finally {
                // With no kill-on-close, the kernel keeps the anonymous job alive until its last member exits.
                if (job != IntPtr.Zero) CloseHandle(job);
            }
        }
    }
}
'@
}

function Start-TrialPlayer {
    [OutputType([System.Diagnostics.Process])]
    param(
        [Parameter(Mandatory, Position=0)][string]$exe,
        [Parameter(Position=1)][AllowNull()][AllowEmptyString()][string]$profile,
        [Parameter(Mandatory, Position=2)][ValidateSet('plain','appid','job','both')][string]$mode
    )
    return [GoyMusic.GroupTrialLauncher]::Start($exe, $profile, $mode)
}
