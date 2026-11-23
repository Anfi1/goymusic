# Windows PowerShell 5.1. Elevated UIA reader only: no Invoke/Expand/Select, file output or process control.
param([Parameter(Mandatory)][ValidatePattern('\Agoy-group-[a-f0-9]{32}\z')][string]$PipeName)
$ErrorActionPreference = 'Stop'
if ($PipeName -cnotmatch '\Agoy-group-[a-f0-9]{32}\z') { exit 2 }

# A hung UIA provider, CIM query, or parent that stops reading must not orphan an elevated process.
$done = [Threading.ManualResetEvent]::new($false)
$watch = [PowerShell]::Create()
$null = $watch.AddScript('param($done) if (!$done.WaitOne(900000)) { [Environment]::Exit(3) }').AddArgument($done)
$watchResult = $watch.BeginInvoke()
$pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, 'InOut', 'None', [Security.Principal.TokenImpersonationLevel]::Anonymous)
try {
    $pipe.Connect(15000)
    $utf8 = [Text.UTF8Encoding]::new($false, $true)
    $reader = [IO.StreamReader]::new($pipe, $utf8, $true, 1024, $true)
    $writer = [IO.StreamWriter]::new($pipe, $utf8, 1024, $true)
    $writer.AutoFlush = $true
    Add-Type -AssemblyName WindowsBase,UIAutomationTypes,UIAutomationClient

    # Define only read-only Win32 calls, in memory. PS 5.1 Add-Type with source runs a disk-based compiler.
    $asm = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('GoyGroupReadOnly'), 'Run')
    $native = $asm.DefineDynamicModule('Observe').DefineType('GoyGroupNative', 'Public, Abstract, Sealed')
    function Add-Native($lib, $name, [type]$ret, [type[]]$argsList) {
        $m = $native.DefinePInvokeMethod($name, $lib, 'Public, Static, PinvokeImpl', 'Standard', $ret, $argsList, 'Winapi', 'Auto')
        $m.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
    }
    Add-Native 'kernel32.dll' OpenProcess ([IntPtr]) @([uint32],[bool],[int])
    Add-Native 'kernel32.dll' CloseHandle ([bool]) @([IntPtr])
    Add-Native 'advapi32.dll' OpenProcessToken ([bool]) @([IntPtr],[uint32],[IntPtr].MakeByRefType())
    Add-Native 'advapi32.dll' GetTokenInformation ([bool]) @([IntPtr],[int],[int].MakeByRefType(),[int],[int].MakeByRefType())
    foreach ($name in 'IsIconic','IsZoomed','IsWindowVisible') { Add-Native 'user32.dll' $name ([bool]) @([IntPtr]) }
    $api = $native.CreateType()
    function Get-Elevation([int]$processId) {
        $h = $api::OpenProcess(0x1000, $false, $processId)
        if (!$h.ToInt64()) { return 'unavailable' }
        try {
            $token = [IntPtr]::Zero
            if (!$api::OpenProcessToken($h, 8, [ref]$token)) { return 'unavailable' }
            try {
                $elev = 0; $used = 0
                if (!$api::GetTokenInformation($token, 20, [ref]$elev, 4, [ref]$used)) { return 'unavailable' }
                if ($elev) { return 'yes' }; return 'no'
            } finally { $null = $api::CloseHandle($token) }
        } finally { $null = $api::CloseHandle($h) }
    }
    $self = [Diagnostics.Process]::GetCurrentProcess()
    $sessionId = $self.SessionId
    if ((Get-Elevation $self.Id) -ne 'yes') { throw 'Observer not elevated' }
    $managerExe = Join-Path ([Environment]::GetFolderPath('System')) 'Taskmgr.exe'
    $cache = [Windows.Automation.CacheRequest]::new()
    $cache.TreeScope = 'Subtree'; $cache.TreeFilter = [Windows.Automation.Automation]::RawViewCondition
    foreach ($k in 'ControlType','AutomationId','Name','IsOffscreen') {
        $prop = $k + 'Property'; $cache.Add([Windows.Automation.AutomationElement]::$prop)
    }
    function Get-WindowState($handle) {
        if ($handle -eq [IntPtr]::Zero -or !$api::IsWindowVisible($handle)) { return 'hidden' }
        if ($api::IsIconic($handle)) { return 'minimized' }
        if ($api::IsZoomed($handle)) { return 'maximized' }; return 'normal'
    }
    function Read-Instances {
        # Filter in WMI; never export command lines. The only text retained from them is a role enum.
        Get-CimInstance Win32_Process -Filter "SessionId=$sessionId AND Name='GoyMusic.exe'" -Property ProcessId,ParentProcessId,ExecutablePath,CreationDate,CommandLine -OperationTimeoutSec 8
    }
    function Get-Family($instances, $main, [long]$birth) {
        $family = @{}; $queue = [Collections.Generic.Queue[int]]::new(); $queue.Enqueue($main.Id)
        $rows = @{}; foreach ($p in $instances) { $rows[[int]$p.ProcessId] = $p }
        while ($queue.Count) {
            $n = $queue.Dequeue(); $p = $rows[$n]
            if (!$p -or $p.ExecutablePath -ne $main.Path -or !$p.CreationDate) { throw 'Unverified process identity' }
            $ticks = $p.CreationDate.ToUniversalTime().Ticks
            # CIM creation timestamps have microsecond precision, unlike Process.StartTime.
            if ($n -eq $main.Id -and [Math]::Abs($birth - $ticks) -ge 10) { throw 'Root changed' }
            if (!$p.CommandLine) { throw 'Unknown process role' }
            $role = 'main'
            if ($p.CommandLine -match '(?:^|\s)"?--type=([\w-]+)') {
                $role = $Matches[1]; if ($role -notin 'renderer','utility','gpu-process','crashpad-handler','zygote') { $role = 'other-helper' }
            } elseif ($n -ne $main.Id) { $role = 'other-helper' }
            if ($n -eq $main.Id -and $role -ne 'main') { throw 'Not a main process' }
            $family[$n] = [pscustomobject]@{pid=$n; parent=[int]$p.ParentProcessId; startedUtcTicks=[string]$ticks; role=$role}
            foreach ($child in $instances) {
                if ($child.ParentProcessId -ne $n -or $family.ContainsKey([int]$child.ProcessId)) { continue }
                if (!$child.ExecutablePath -or !$child.CreationDate) { throw 'Unknown child' }
                if ($child.ExecutablePath -eq $main.Path -and $child.CreationDate -ge $p.CreationDate) { $queue.Enqueue([int]$child.ProcessId) }
            }
        }
        return $family
    }
    function Measure-Group([string]$label, [int]$mainId, [long]$birth) {
        $issues = [Collections.Generic.List[string]]::new(); $rows = [Collections.Generic.List[object]]::new()
        $r = [ordered]@{sample=$label;pid=$mainId;startedUtcTicks=[string]$birth;status='inconclusive';grouped=0;total=0;seen=0;windowState='unknown';version=$null;mainElevated='unavailable';taskManagerVersion=$null;taskManagerPid=$null;taskManagerElevated='unavailable';memoryHeader=$null;inventory=@();rows=$rows;issues=$issues}
        $stage = 'task-manager'
        try {
            $managers = @(Get-Process -Name Taskmgr -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $sessionId -and $_.MainWindowHandle -ne 0 -and $_.Path -eq $managerExe })
            if ($managers.Count -ne 1) { throw 'No unique system Task Manager' }
            $tm = $managers[0]; $r.taskManagerPid = $tm.Id; $r.taskManagerVersion = $tm.FileVersion; $r.taskManagerElevated = Get-Elevation $tm.Id
            $stage = 'root-identity'; $main = Get-Process -Id $mainId
            if ($main.SessionId -ne $sessionId -or $main.ProcessName -ne 'GoyMusic' -or !$main.Path -or $main.StartTime.ToUniversalTime().Ticks -ne $birth) { throw 'Wrong root' }
            $r.mainElevated = Get-Elevation $mainId; $r.windowState = Get-WindowState $main.MainWindowHandle
            # Do not perform a privileged version-resource lookup on a caller-chosen network share.
            if ($main.Path -notmatch '^[A-Za-z]:\\' -or [IO.DriveInfo]::new([IO.Path]::GetPathRoot($main.Path)).DriveType -ne 'Fixed') { throw 'Not a local installation' }
            $r.version = $main.ProductVersion -replace '[^0-9.].*$',''
            $r.taskManagerStartedUtcTicks = [string]$tm.StartTime.ToUniversalTime().Ticks
            $stage = 'inventory'; $before = @(Read-Instances); $targets = Get-Family $before $main $birth
            $r.inventory = @($targets.Values | Sort-Object pid); $r.total = $targets.Count
            if ($r.total -lt 2 -or $r.inventory.role -notcontains 'renderer') { $issues.Add('missing-electron-children') }
            $appPids = @{}; foreach ($p in $before) { $appPids[[int]$p.ProcessId] = $true }
            $stage = 'processes-page'; $root = [Windows.Automation.AutomationElement]::FromHandle($tm.MainWindowHandle).GetUpdatedCache($cache)
            $headers = [Collections.Generic.List[string]]::new(); $sets = @{}; $locations = @{}; $foreign = @{}
            function Visit($el, [string]$path, [string]$group, [bool]$unidentified) {
                $c = $el.Cached
                if ($c.AutomationId -eq 'TmColMemory' -and !$c.IsOffscreen) { $headers.Add($c.Name) }
                if ($c.ControlType -eq [Windows.Automation.ControlType]::Group -and $c.AutomationId -like 'TmGroupHeader_*') { $group = ''; $unidentified = $false }
                if ($c.ControlType -eq [Windows.Automation.ControlType]::TreeItem) {
                    $n = 0
                    if ($c.AutomationId -match '^\d+:(\d+)$') { $null = [int]::TryParse($Matches[1],[ref]$n) }
                    # The first concrete app row supplies the group key, never its caption. A child window
                    # detail with the same PID cannot increase the set cardinality.
                    if (!$group) {
                        if ($c.Name -match '^GoyMusic\b' -or $targets.ContainsKey($n)) { $group = $path }
                        else { $unidentified = $true }
                    }
                    if ($targets.ContainsKey($n)) {
                        if ($unidentified -and !$issues.Contains('unidentified-app-ancestor')) { $issues.Add('unidentified-app-ancestor') }
                        if (!$sets.ContainsKey($group)) { $sets[$group] = @{} }; $sets[$group][$n] = $true
                        if ($locations.ContainsKey($n) -and $locations[$n] -ne $group -and !$issues.Contains('conflicting-pid-rows')) { $issues.Add('conflicting-pid-rows') }
                        $locations[$n] = $group
                        $rows.Add([pscustomobject]@{pid=$n;row=$path;group=$group;onscreen=!$c.IsOffscreen})
                    } elseif ($group -and $appPids.ContainsKey($n)) { $foreign[$group] = $true }
                }
                $i = 0; foreach ($child in $el.CachedChildren) { Visit $child "$path.$i" $group $unidentified; $i++ }
            }
            Visit $root '0' '' $false
            # Export a normalized sort observation, never raw UI captions/window titles. Accept Russian
            # and English accessibility labels; unfamiliar locales MUST NOT silently pass as descending.
            $desc = '(?is)\bSorted\s*\(\s*descending\s*\)|\u0443\u0431\u044b\u0432\u0430\u043d\u0438\u044e'
            if ($headers.Count -eq 1 -and $headers[0] -match $desc) { $r.memoryHeader = 'Memory Sorted (descending)' }
            else { $r.memoryHeader = 'unverified'; $issues.Add('memory-descending-not-verified') }
            $r.seen = $locations.Count
            if ($r.seen -ne $r.total) { $issues.Add('missing-pid-rows') }
            foreach ($g in $sets.Keys) {
                $r.grouped = [Math]::Max($r.grouped, $sets[$g].Count)
                if ($foreign.ContainsKey($g)) { $issues.Add('row-also-contains-another-player') }
            }
            $stage = 'inventory-recheck'; $after = Get-Family @(Read-Instances) $main $birth
            if ($main.HasExited -or $tm.HasExited -or $after.Count -ne $targets.Count) { throw 'Processes changed' }
            foreach ($n in $targets.Keys) { if (!$after.ContainsKey($n) -or $after[$n].startedUtcTicks -ne $targets[$n].startedUtcTicks) { throw 'Processes changed' } }
            $main.Refresh(); if ((Get-WindowState $main.MainWindowHandle) -ne $r.windowState) { $issues.Add('window-state-changed') }
            if (!$issues.Count) { $r.status = if ($r.grouped -eq $r.total) { 'grouped' } else { 'separate' } }
        } catch { $issues.Add("unavailable-$stage") }
        [pscustomobject]$r
    }
    $writer.WriteLine('{"ready":true}')
    while ($true) {
        # Bound input before JSON parsing, even if the peer omits the newline. No dynamic invocation.
        $line = [Text.StringBuilder]::new(256)
        while (($ch = $reader.Read()) -ge 0 -and $ch -ne 10) {
            if ($line.Length -ge 512) { throw 'Request too large' }; $null = $line.Append([char]$ch)
        }
        if ($ch -lt 0) { break }; $q = $line.ToString() | ConvertFrom-Json
        if ($q.stop -is [bool] -and $q.stop) { break }
        if ($q.sample -isnot [string] -or $q.sample -cnotmatch '\A[A-Za-z0-9_.-]{1,64}\z' -or ($q.pid -isnot [int] -and $q.pid -isnot [long]) -or $q.pid -le 0 -or $q.pid -gt [int]::MaxValue -or $q.startedUtcTicks -isnot [string] -or $q.startedUtcTicks -notmatch '\A[0-9]{1,18}\z') { throw 'Invalid request' }
        $reply = Measure-Group $q.sample $q.pid ([long]$q.startedUtcTicks)
        $writer.WriteLine((ConvertTo-Json -InputObject $reply -Depth 6 -Compress))
    }
} finally {
    $pipe.Dispose(); $null = $done.Set(); $watch.EndInvoke($watchResult); $watch.Dispose(); $done.Dispose()
}
