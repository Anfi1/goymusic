param([Parameter(Mandatory)][int]$RootPid, [Parameter(Mandatory)][ValidateSet('idle','playing','minimized')][string]$Mode)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RamWindow {
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
}
'@
$root = Get-Process -Id $RootPid
$hwnd = $root.MainWindowHandle
function Assert-WindowState {
    if ($root.HasExited -or ![RamWindow]::IsWindowVisible($hwnd) -or [RamWindow]::IsIconic($hwnd) -ne ($Mode -eq 'minimized')) {
        throw "Window of PID $RootPid not in expected state: $Mode"
    }
}
function Get-TreeSample {
    Assert-WindowState
    # Parentage, PID and private RESIDENT bytes come from the same performance snapshot.
    # Win32_Process is just metadata for role labels, never a filter on tree membership.
    $metadata = @{}
    foreach ($p in Get-CimInstance Win32_Process -Property ProcessId,Name,CommandLine) { $metadata[[int]$p.ProcessId] = $p }
    $perf = @(Get-CimInstance Win32_PerfRawData_PerfProc_Process -Property IDProcess,CreatingProcessID,Name,WorkingSetPrivate)
    $pending = [Collections.Generic.Queue[object]]::new()
    $main = @($perf | Where-Object IDProcess -eq $RootPid)
    if ($main.Count -ne 1) { throw "Missing or ambiguous performance instance for PID $RootPid" }
    $pending.Enqueue($main[0])
    $members = while ($pending.Count) {
        $p = $pending.Dequeue()
        $id = [int]$p.IDProcess
        $m = $metadata[$id]
        $name = if ($m) { $m.Name } else { $p.Name -replace '#\d+$' }
        $role = if ($id -eq $RootPid) { 'electron-main' }
            elseif ($m.CommandLine -match '--utility-sub-type=([^"\s]+)') { "utility:$($Matches[1])" }
            elseif ($m.CommandLine -match '--type=([^"\s]+)') { $Matches[1] }
            elseif ($name -ieq 'python.exe' -and $p.CreatingProcessID -eq $RootPid) { 'python-backend' }
            else { $name }
        if ($null -eq $p.WorkingSetPrivate) { throw "No private working-set counter for $name ($id)" }
        [pscustomobject]@{ pid = $id; parentPid = [int]$p.CreatingProcessID; role = $role; privateWorkingSetBytes = [long]$p.WorkingSetPrivate }
        foreach ($child in $perf) {
            if ($child.IDProcess -and $child.CreatingProcessID -eq $id) { $pending.Enqueue($child) }
        }
    }
    if ('renderer' -notin $members.role -or 'python-backend' -notin $members.role) { throw 'Incomplete installed app tree: no renderer or Python backend' }
    Assert-WindowState
    [pscustomobject]@{ at = [DateTime]::UtcNow.ToString('o'); processes = @($members) }
}
$samples = @(for ($i = 0; $i -lt 7; $i++) {
    if ($i) { Start-Sleep -Seconds 1 }
    Get-TreeSample
})
ConvertTo-Json -InputObject $samples -Depth 5 -Compress
