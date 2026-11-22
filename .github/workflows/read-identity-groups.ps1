function Measure-IdentityGroups([string]$dir,[string]$label,[int]$mainPid,[int]$backendPid,[int]$nodePid) {
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
    if (!('GoyPackageFamily' -as [type])) { Add-Type @'
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class GoyPackageFamily {
    [DllImport("kernel32.dll", SetLastError=true)] static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] static extern int GetPackageFamilyName(SafeProcessHandle process, ref uint size, StringBuilder name);
    public static int Query(int pid, out string family) {
        family = null;
        using (var process = OpenProcess(0x1000, false, pid)) { // PROCESS_QUERY_LIMITED_INFORMATION
            if (process.IsInvalid) return Marshal.GetLastWin32Error();
            uint size = 0;
            int rc = GetPackageFamilyName(process, ref size, null);
            if (rc != 122) return rc; // 15700 = APPMODEL_ERROR_NO_PACKAGE; not an access failure.
            var name = new StringBuilder(checked((int)size));
            rc = GetPackageFamilyName(process, ref size, name);
            if (rc == 0) family = name.ToString();
            return rc;
        }
    }
}
'@
    }
    $exe = Join-Path $dir 'GoyMusic.exe'; $pythonDir = Join-Path $dir 'resources\python'
    $session = (Get-Process -Id $PID).SessionId
    $cache = [Windows.Automation.CacheRequest]::new(); $cache.TreeScope = 'Subtree'; $cache.TreeFilter = [Windows.Automation.Automation]::RawViewCondition
    foreach ($k in 'Name','AutomationId','ControlType','IsOffscreen') { $prop="${k}Property"; $cache.Add([Windows.Automation.AutomationElement]::$prop) }
    $expandState = [Windows.Automation.ExpandCollapsePattern]::ExpandCollapseStateProperty; $cache.Add($expandState)
    $treeItems = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::TreeItem)
    function Capture($index) {
        $targets = @{}; $rows = [Collections.Generic.List[object]]::new(); $issues = [Collections.Generic.List[string]]::new()
        $header = @{memory='missing'}; $version = $null
        try {
            $processes = Get-CimInstance Win32_Process -Filter "SessionId=$session AND (Name='GoyMusic.exe' OR ProcessId=$backendPid OR ProcessId=$nodePid)"
            foreach ($p in $processes) {
                $n = [int]$p.ProcessId
                if ($p.ExecutablePath -eq $exe) { $role = if ($n -eq $mainPid) {'main'} else {'electron-helper'} }
                elseif ($n -eq $backendPid -and $p.ExecutablePath -eq "$pythonDir\bin\python.exe") { $role='backend' }
                elseif ($n -eq $nodePid -and $p.Name -eq 'node.exe' -and $p.ExecutablePath.StartsWith("$pythonDir\",[StringComparison]::OrdinalIgnoreCase) -and $p.ParentProcessId -eq $backendPid) { $role='node' }
                else { if ($p.Name -eq 'GoyMusic.exe' -and !$p.ExecutablePath) { $issues.Add("Unknown executable path for $n") }; continue }
                $family = $null; $rc = [GoyPackageFamily]::Query($n,[ref]$family)
                $targets[$n] = [pscustomobject]@{ProcessId=$n;ParentProcessId=$p.ParentProcessId;Name=$p.Name;path=$p.ExecutablePath;started=$p.CreationDate;role=$role;packageFamily=$family;packageResult=$rc}
                if ($rc -notin 0,15700) { $issues.Add("Package family query for ${n}: $rc") }
            }
            foreach ($role in 'main','electron-helper','backend','node') { if ($role -notin $targets.Values.role) { $issues.Add("Missing $role") } }
            $manager = Get-Process Taskmgr | Where-Object { $_.MainWindowHandle -ne 0 -and $_.SessionId -eq $session } | Select-Object -First 1
            if (!$manager) { throw 'No Task Manager HWND' }
            $version = $manager.FileVersion; $root = [Windows.Automation.AutomationElement]::FromHandle($manager.MainWindowHandle)
            foreach ($e in $root.FindAll([Windows.Automation.TreeScope]::Descendants,$treeItems)) {
                $id=$e.Current.AutomationId
                $n=0
                if ($e.Current.Name -notmatch '^GoyMusic\b' -and !($id -match '^\d+:(\d+)$' -and [int]::TryParse($Matches[1],[ref]$n) -and $targets.ContainsKey($n))) { continue }
                $pattern=$null
                if ($e.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$pattern) -and $pattern.Current.ExpandCollapseState -eq 'Collapsed') { $pattern.Expand() }
            }
            # Each key denotes ONE concrete TreeItem in this cache, never a shared display name.
            function Visit($e,$parents,$group,$uncertain) {
                $c=$e.Cached; $type=$c.ControlType.ProgrammaticName; $id=$c.AutomationId; $name=$c.Name
                if ($id -eq 'TmColMemory') { $header.memory=$name }
                if ($type -eq 'ControlType.Group' -and $id -like 'TmGroupHeader_*') { $parents=@($name); $group=$null; $uncertain=$false }
                if ($type -eq 'ControlType.TreeItem') {
                    $n=0
                    if ($id -match '^\d+:(\d+)$') { $null=[int]::TryParse($Matches[1],[ref]$n) }
                    $isApp = $name -match '^GoyMusic\b'; $state = $e.GetCachedPropertyValue($expandState,$true)
                    if ($isApp -and !$group -and $state -eq [Windows.Automation.ExpandCollapseState]::Expanded) { $group="row-$($rows.Count)" }
                    if ($targets.ContainsKey($n) -or $isApp) {
                        $rows.Add([pscustomobject]@{name=$name;id=$id;pid=$n;image=$targets[$n].Name;parents=@($parents);group=$group;expandState="$state";onscreen=!$c.IsOffscreen})
                        if ($targets.ContainsKey($n) -and $uncertain) { $issues.Add("Unverified group ancestor for $n") }
                    }
                    $uncertain = $uncertain -or ($isApp -and !$group); $parents=@($parents)+@($name)
                }
                foreach ($child in $e.CachedChildren) { Visit $child $parents $group $uncertain }
            }
            Visit ($root.GetUpdatedCache($cache)) @() $null $false
        } catch { $issues.Add($_.Exception.Message) }
        if ($header.memory -notmatch '(?s)^Memory\b.*?\bSorted\s*\(\s*descending\s*\)') { $issues.Add('Memory descending not verified') }
        $seen = @($rows | Where-Object image | Select-Object -ExpandProperty pid -Unique)
        if ($seen.Count -ne $targets.Count) { $issues.Add('Not all target PIDs have UI rows') }
        $sets = @(foreach ($g in ($rows | Where-Object { $_.group -and $_.image } | Group-Object group)) { ($g.Group.pid | Sort-Object -Unique) -join ',' })
        $grouped = 0; foreach ($s in $sets) { $grouped=[Math]::Max($grouped,$s.Split(',').Length) }
        foreach ($p in ($rows | Where-Object image | Group-Object pid)) { if (@($p.Group | Group-Object group).Count -gt 1) { $issues.Add("Conflicting rows for $($p.Name)") } }
        $status = if ($issues.Count) {'inconclusive'} elseif ($grouped -eq $targets.Count) {'grouped'} else {'separate'}
        [pscustomobject]@{sample=$index;status=$status;grouped=$grouped;seen=$seen.Count;total=$targets.Count;rows=$rows;inventory=@($targets.Values | Sort-Object ProcessId);groupMembers=@($sets | Sort-Object);taskmgrVersion=$version;memoryHeader=$header.memory;issues=$issues}
    }
    Start-Sleep -Seconds 20
    $a=Capture 1; Start-Sleep -Seconds 4; $b=Capture 2
    $consistent = $a.status -eq $b.status -and ($a.groupMembers -join ';') -eq ($b.groupMembers -join ';') -and (ConvertTo-Json -Compress $a.inventory) -ceq (ConvertTo-Json -Compress $b.inventory)
    $status = if ($consistent) { $b.status } else { 'inconclusive' }
    $os=Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture
    [pscustomobject]@{tag=$label;os=$os;mainPid=$mainPid;backendPid=$backendPid;nodePid=$nodePid;status=$status;consistent=$consistent;grouped=$b.grouped;seen=$b.seen;total=$b.total;samples=@($a,$b)} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath "observations/$label.json"
    "$status ($($b.grouped)/$($b.total) targets in one group; $($b.seen) seen)"
}
