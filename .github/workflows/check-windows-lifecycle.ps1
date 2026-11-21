param([Parameter(Mandatory)][string]$InstallDir, [int]$RelaunchedPid)
$ErrorActionPreference = 'Stop'
$exe = Join-Path $InstallDir 'GoyMusic.exe'
$python = Join-Path $InstallDir 'resources\python\bin\python.exe'
$appId = (Get-Content package.json -Raw | ConvertFrom-Json).build.appId
$logs = Join-Path $env:RUNNER_TEMP "goy-lifecycle-$([guid]::NewGuid())"
$null = New-Item -ItemType Directory $logs

# Read the visible HWND's explicit taskbar identity, not the identity inferred from a shortcut.
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class GoyWindow {
    delegate bool EnumProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out int process);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd, int command);
    public static IntPtr[] Visible(int pid) {
        var found = new List<IntPtr>();
        EnumWindows((hwnd, unused) => {
            int owner; GetWindowThreadProcessId(hwnd, out owner);
            if (owner == pid && IsWindowVisible(hwnd)) {
                var name = new StringBuilder(128); GetClassName(hwnd, name, name.Capacity);
                if (name.ToString() == "Chrome_WidgetWin_1") found.Add(hwnd);
            }
            return true;
        }, IntPtr.Zero);
        return found.ToArray();
    }
    [StructLayout(LayoutKind.Sequential)] struct Key { public Guid fmtid; public uint pid; }
    [StructLayout(LayoutKind.Explicit, Size=24)] struct Value {
        [FieldOffset(0)] public ushort type; [FieldOffset(8)] public IntPtr str;
    }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface Store { void GetCount(out uint count); void GetAt(uint i, out Key k); void GetValue(ref Key k, out Value v); }
    [DllImport("shell32.dll", PreserveSig=false)] static extern void SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, out Store store);
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref Value value);
    public static string AppId(IntPtr hwnd) {
        var iid = typeof(Store).GUID; Store store; SHGetPropertyStoreForWindow(hwnd, ref iid, out store);
        try {
            var key = new Key { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
            Value v; store.GetValue(ref key, out v);
            try { return v.type == 31 ? Marshal.PtrToStringUni(v.str) : null; }
            finally { PropVariantClear(ref v); }
        } finally { Marshal.ReleaseComObject(store); }
    }
}
'@

function Wait-Until($description, [scriptblock]$condition, $seconds = 30) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    do {
        if (& $condition) { return }
        Start-Sleep -Milliseconds 100
    } while ($clock.Elapsed.TotalSeconds -lt $seconds)
    throw "Timed out: $description"
}
function Start-App($label) {
    # The installed exe and all its launches use the same default profile on this clean runner.
    Start-Process $exe -PassThru -RedirectStandardError "$logs/$label.err" -RedirectStandardOutput "$logs/$label.out"
}
function Get-Primaries {
    Get-CimInstance Win32_Process -Filter "Name='GoyMusic.exe'" | Where-Object {
        $_.ExecutablePath -eq $exe -and $_.CommandLine -notmatch '(?:^|\s)"?--type='
    }
}
function Get-Backends {
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.ExecutablePath -eq $python }
}
function Close-App($primary) {
    $null = $primary.Handle # keep the relaunched process queryable after WM_CLOSE
    $primary.Refresh()
    if (!$primary.CloseMainWindow()) { throw "WM_CLOSE failed for primary $($primary.Id)" }
    if (!$primary.WaitForExit(15000) -or $primary.ExitCode -ne 0) { throw "Unclean primary exit: $($primary.Id)" }
    Wait-Until 'all installed Electron helpers and Python have exited' {
        !(Get-Process GoyMusic -ErrorAction SilentlyContinue | Where-Object Path -eq $exe) -and !(Get-Backends)
    }
    $files = @(Get-ChildItem $logs -File) + @(Get-Item "$InstallDir/resources/app.log")
    $errorsFound = $files | Select-String 'Object (has been|was|is) destroyed|JavaScript error occurred in the main process|Uncaught Exception:'
    if ($errorsFound) { throw ($errorsFound -join "`n") }
}

$marker = $null
try {
    $shell = New-Object -ComObject Shell.Application
    $links = @(foreach ($folder in 'Programs','CommonPrograms') {
        Get-ChildItem ([Environment]::GetFolderPath($folder)) -Filter 'GoyMusic.lnk' -Recurse | ForEach-Object {
            $item = $shell.NameSpace($_.DirectoryName).ParseName($_.Name)
            if ($item.ExtendedProperty('System.Link.TargetParsingPath') -eq $exe) { $item }
        }
    })
    if (!$links.Count) { throw "No Start menu shortcut targeting $exe" }
    foreach ($link in $links) {
        if ($link.ExtendedProperty('System.AppUserModel.ID') -cne $appId) { throw "Wrong shortcut AppUserModelID: $($link.Path)" }
    }
    if ($RelaunchedPid) {
        $primary = Get-Process -Id $RelaunchedPid
    } else {
        # Simulate the installer's exclusive handle after the old primary has quit.
        # An unlocked, leftover marker must not block the next real startup.
        $marker = Join-Path ([IO.Path]::GetTempPath()) 'com.goymusic.app.update-lock'
        $lock = [IO.File]::Open($marker, 'OpenOrCreate', 'ReadWrite', 'None')
        try {
            if ((Get-Primaries) -or (Get-Backends)) { throw 'Expected no app running before update-lock test' }
            $blocked = Start-App 'during-install'
            if (!$blocked.WaitForExit(15000) -or $blocked.ExitCode -ne 0) { throw 'Launch during install did not exit cleanly' }
            if ((Get-Primaries) -or (Get-Backends) -or (Test-Path "$InstallDir/resources/app.log")) { throw 'Launch during install initialized the application' }
        } finally { $lock.Dispose() }
        # During cold startup any of these PIDs can acquire the lock first.
        $burst = @(1..4 | ForEach-Object { Start-App "cold-$_" })
        Wait-Until 'exactly one surviving cold launch with a native window' {
            $live = @($burst | Where-Object { !$_.HasExited })
            $live.Count -eq 1 -and [GoyWindow]::Visible($live[0].Id).Length -eq 1
        }
        $primary = $burst | Where-Object { !$_.HasExited }
        foreach ($p in $burst) { if ($p.HasExited -and $p.ExitCode -ne 0) { throw "Cold duplicate $($p.Id) exited $($p.ExitCode)" } }
    }
    $windows = [GoyWindow]::Visible($primary.Id)
    if ($windows.Length -ne 1 -or [GoyWindow]::AppId($windows[0]) -cne $appId) { throw 'Expected one main window with the installer AppUserModelID' }
    $hwnd = $windows[0]
    $null = [GoyWindow]::ShowWindowAsync($hwnd, 6) # SW_MINIMIZE
    Wait-Until 'main window minimized' { [GoyWindow]::IsIconic($hwnd) }
    $duplicates = @(1..3 | ForEach-Object { Start-App "warm-$_" })
    foreach ($p in $duplicates) {
        if (!$p.WaitForExit(15000) -or $p.ExitCode -ne 0) { throw "Duplicate $($p.Id) did not exit cleanly" }
    }
    Wait-Until 'same main window restored' { ![GoyWindow]::IsIconic($hwnd) }
    $roots = @(Get-Primaries)
    $backends = @(Get-Backends)
    $windows = [GoyWindow]::Visible($primary.Id)
    if ($roots.Count -ne 1 -or $roots[0].ProcessId -ne $primary.Id -or $windows.Length -ne 1 -or $windows[0] -ne $hwnd) { throw 'Primary PID or main HWND changed after duplicate launches' }
    if ($backends.Count -ne 1 -or $backends[0].ParentProcessId -ne $primary.Id) { throw 'Expected one installed Python backend owned by the primary' }
    Write-Output "Primary PID $($primary.Id), HWND $hwnd, backend PID $($backends[0].ProcessId), AppUserModelID $appId"
    Close-App $primary

    if (!$RelaunchedPid) {
        # Separate from the slower identity checks: WM_CLOSE immediately on a fresh window,
        # while the 5s initial updater/backend callbacks are still pending.
        $quick = Start-App 'quick-close'
        Wait-Until 'quick-close window visible' { [GoyWindow]::Visible($quick.Id).Length -eq 1 }
        Close-App $quick
    }
} catch {
    Get-Primaries | Format-List ProcessId, CommandLine | Out-Host
    Get-Backends | Format-List ProcessId, ParentProcessId | Out-Host
    Get-Content "$InstallDir/resources/app.log", "$logs/*.err" -Tail 30 -ErrorAction SilentlyContinue | Out-Host
    throw
} finally {
    if ($marker -and (Test-Path $marker)) { Remove-Item $marker }
}
