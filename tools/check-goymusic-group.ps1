param([string]$OutFile = (Join-Path $PSScriptRoot 'goymusic-group.json'))
$ErrorActionPreference = 'Stop'
$session = (Get-Process -Id $PID).SessionId
$os = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$report = [ordered]@{windowsBuild="$($os.CurrentBuild).$($os.UBR)"; taskManagerVersion=$null; samples=@()}
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class GroupToken {
    [DllImport("kernel32")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("advapi32")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32")] static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int bytes, out int used);
    [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);
    public static string Elevated(int pid) {
        var p=OpenProcess(0x1000,false,pid); if(p==IntPtr.Zero)return "unavailable";
        try { IntPtr t; if(!OpenProcessToken(p,8,out t))return "unavailable";
            try {int v,used; return GetTokenInformation(t,20,out v,4,out used)?(v==0?"no":"yes"):"unavailable";}
            finally {CloseHandle(t);}
        } finally {CloseHandle(p);}
    }
}
'@
$paths=@{}
function Snapshot {
    $snap=[ordered]@{timeUtc=[DateTime]::UtcNow.ToString('o'); memoryHeader=$null; taskManagerElevated=$null; processes=@(); uiError=$null}
    $rows=@{}; $raw=@(Get-CimInstance Win32_Process -Filter "Name='GoyMusic.exe' AND SessionId=$session")
    foreach ($p in $raw) {
        $key=$p.ExecutablePath; $install='unknown'; $version=$null
        if ($key) {
            if (!$paths.ContainsKey($key)) { $paths[$key]='install-'+(1+$paths.Count) }
            $install=$paths[$key]; $version=[Diagnostics.FileVersionInfo]::GetVersionInfo($key).ProductVersion
        }
        $role=if (!$p.CommandLine) {'unknown'} elseif ($p.CommandLine -match '(?:^|\s)"?--type=([\w-]+)') {$Matches[1]} else {'main'}
        $entry=[pscustomobject]@{pid=[int]$p.ProcessId; parent=[int]$p.ParentProcessId; role=$role; install=$install; version=$version; elevated=[GroupToken]::Elevated($p.ProcessId); taskManagerRows=@()}
        $rows[[int]$p.ProcessId]=$entry
    }
    $snap.processes=@($rows.Values | Sort-Object pid)
    try {
        $tm=Get-Process Taskmgr -ErrorAction Stop | Where-Object { $_.SessionId -eq $session -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if (!$tm) { throw 'Open Task Manager on the Processes page, then retry.' }
        $report.taskManagerVersion=$tm.FileVersion; $snap.taskManagerElevated=[GroupToken]::Elevated($tm.Id)
        $root=[Windows.Automation.AutomationElement]::FromHandle($tm.MainWindowHandle)
        $cache=[Windows.Automation.CacheRequest]::new(); $cache.TreeScope='Subtree'; $cache.TreeFilter=[Windows.Automation.Automation]::RawViewCondition
        foreach ($prop in 'ControlType','Name','AutomationId','IsOffscreen') { $k="${prop}Property"; $cache.Add([Windows.Automation.AutomationElement]::$k) }
        function Visit($el,$path,$parentGroup) {
            $c=$el.Cached
            if ($c.AutomationId -eq 'TmColMemory') { $snap.memoryHeader=$c.Name }
            if ($c.ControlType -eq [Windows.Automation.ControlType]::TreeItem) {
                $n=0
                if ($c.AutomationId -match '^\d+:(\d+)$' -and [int]::TryParse($Matches[1],[ref]$n) -and $rows.ContainsKey($n)) {
                    $rows[$n].taskManagerRows+=@([pscustomobject]@{row=$path; parentGoyMusicRow=$parentGroup; onscreen=!$c.IsOffscreen})
                }
                if ($c.Name -match '^GoyMusic\b' -and !$parentGroup) { $parentGroup=$path }
            }
            $i=0; foreach ($child in $el.CachedChildren) { Visit $child "$path.$i" $parentGroup; $i++ }
        }
        Visit ($root.GetUpdatedCache($cache)) '0' $null
        if (!$snap.memoryHeader) { $snap.uiError='Processes page not accessible; no grouping conclusion.' }
    } catch { $snap.uiError=$_.Exception.GetType().Name+': could not read Processes page' }
    [pscustomobject]$snap
}
$report.samples=@((Snapshot); Start-Sleep -Seconds 3; (Snapshot))
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutFile -Encoding UTF8
Write-Host "Saved $OutFile"
