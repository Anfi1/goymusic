# Dot-sourced by probe.ps1. All interaction is with the system Task Manager on the runner's desktop.
function Open-DesktopProbe {
    Add-Type -AssemblyName System.Windows.Forms,System.Drawing.Common
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ProbeDesktop {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, int data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
    $null = [ProbeDesktop]::SetThreadDpiAwarenessContext([IntPtr](-4))
}
function Save-Screen($name) {
    try {
        $r = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $image = [Drawing.Bitmap]::new($r.Width,$r.Height)
        $g = [Drawing.Graphics]::FromImage($image)
        try { $g.CopyFromScreen($r.Location,[Drawing.Point]::Empty,$r.Size) } finally { $g.Dispose() }
        $image.Save((Join-Path $EvidenceDir "$name.png"),[Drawing.Imaging.ImageFormat]::Png)
    } catch { Note "Screenshot $name unavailable: $_" } finally { if ($image) { $image.Dispose() } }
}
function Save-View($name) {
    # One provider snapshot; per-cell cross-process reads are both slow and inconsistent on a live grid.
    Assert-Foreground
    $root = [Windows.Automation.AutomationElement]::FromHandle($hwnd).GetUpdatedCache($cache)
    $items = [Collections.Generic.List[object]]::new()
    $bounds = $root.Cached.BoundingRectangle
    function Visit($e, $path, $owner) {
        $c = $e.Cached
        $r = $c.BoundingRectangle
        $type = $c.ControlType.ProgrammaticName -replace '^ControlType\.'
        $row = $c.AutomationId -eq 'TmViewRow' -or $type -in 'DataItem','ListItem','TreeItem'
        $expand = $e.GetCachedPropertyValue([Windows.Automation.ExpandCollapsePattern]::ExpandCollapseStateProperty, $true)
        $item = [pscustomobject]@{path=$path; rowOwner=$owner; type=$type; id=$c.AutomationId; name=$c.Name; row=$row;
            state=$(if ($expand -is [Windows.Automation.ExpandCollapseState]) { $expand.ToString() });
            visible=(!$c.IsOffscreen -and !$r.IsEmpty -and $r.Width -gt 0 -and $r.Height -gt 0 -and $bounds.IntersectsWith($r));
            x=$(if (!$r.IsEmpty) {[int]$r.Left}); y=$(if (!$r.IsEmpty) {[int]$r.Top});
            w=$(if (!$r.IsEmpty) {[int]$r.Width}); h=$(if (!$r.IsEmpty) {[int]$r.Height}); element=$e}
        $items.Add($item)
        if ($row) { $owner = $path }
        $i = 0
        foreach ($child in $e.CachedChildren) { Visit $child "$path.$i" $owner; $i++ }
    }
    Visit $root '0' ''
    if ($name) {
        Save-Json "$name-uia.json" @($items | Select-Object * -ExcludeProperty element)
        Save-Screen $name
    }
    $items.ToArray()
}
function Get-Rows($view) {
    $nativeGrid = $view | Where-Object id -eq 'TmViewRow' | Select-Object -First 1
    $cells = @{}
    foreach ($item in $view) {
        if ($item.rowOwner -and $item.visible -and !$item.row -and $item.name) {
            if (!$cells.ContainsKey($item.rowOwner)) { $cells[$item.rowOwner] = [Collections.Generic.List[object]]::new() }
            $cells[$item.rowOwner].Add($item)
        }
    }
    foreach ($r in $view) {
        if (!$r.row -or !$r.visible -or ($nativeGrid -and $r.id -ne 'TmViewRow')) { continue }
        $values = $cells[$r.path]
        $names = @(@($r.name; foreach ($c in $values) { $c.name }) -ne '')
        # Identity of the first name cell, not the resource columns which update continuously.
        $nameCell = $values | Where-Object { $_.id -ne 'TmRowIcon' -and $_.name -match '\p{L}' } | Sort-Object x | Select-Object -First 1
        $label = if ($nameCell) { $nameCell.name } else { $r.name }
        $label = ($label -split '(?i)[,;]\s*(?:CPU|Memory|Status|Disk|Network|PID)\s*:',2)[0]
        [pscustomobject]@{node=$r; names=$names; label=$label; cells=$values}
    }
}
function Find-Lab($rows) {
    $found = @($rows | Where-Object { ($_.names -match '(?i)^(?:Name\s*:\s*)?GoyMusic MSIX Lab(?:\.exe)?(?:\s*\(\d+\))?(?:$|\s*[,;])').Count } | Sort-Object { $_.node.y })
    # An expanded group can contain same-named Electron subprocesses. The parent is the first row.
    if ($found.Count) { $found[0] }
}
function Assert-Foreground {
    if ([ProbeDesktop]::GetForegroundWindow() -ne $hwnd) { throw 'Task Manager is not the foreground window; no input sent' }
}
function Click-Cell($cell, [switch]$Right) {
    Assert-Foreground
    $x = $cell.x + [Math]::Min(90,[int]($cell.w/2)); $y = $cell.y + [int]($cell.h/2)
    if (![ProbeDesktop]::SetCursorPos($x,$y)) { throw 'Cannot position pointer on Task Manager' }
    $down,$up = if ($Right) { 8,16 } else { 2,4 }
    [ProbeDesktop]::mouse_event($down,0,0,0,[UIntPtr]::Zero); [ProbeDesktop]::mouse_event($up,0,0,0,[UIntPtr]::Zero)
}
function Set-LabOpen($lab, [bool]$open) {
    if (!$lab) { throw 'No visible GoyMusic MSIX Lab group row on Processes' }
    Assert-Foreground
    $pattern = $null
    if ($lab.node.element.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$pattern) -and $pattern.Current.ExpandCollapseState -ne 'LeafNode') {
        if ($open -and $pattern.Current.ExpandCollapseState -ne 'Expanded') { $pattern.Expand() }
        if (!$open -and $pattern.Current.ExpandCollapseState -ne 'Collapsed') { $pattern.Collapse() }
    } else {
        Click-Cell $lab.node
        Assert-Foreground
        [Windows.Forms.SendKeys]::SendWait($(if ($open) {'{RIGHT}'} else {'{LEFT}'}))
    }
    Start-Sleep -Milliseconds 600
}
function Enable-PidColumn($view,$lab) {
    if ($view | Where-Object {$_.visible -and $_.name -ceq 'PID' -and $_.y -lt $lab.node.y}) { return }
    $header = $view | Where-Object { $_.visible -and $_.name -match '^Name(?:$|, sorted\b)' -and $_.y -lt $lab.node.y } | Sort-Object y -Descending | Select-Object -First 1
    if (!$header) { return }
    Click-Cell $header -Right
    Start-Sleep -Milliseconds 350
    # A Win32 popup can be a separate HWND, not a descendant of the modern Task Manager frame.
    $owner = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$manager.Id)
    $cond = [Windows.Automation.AndCondition]::new(
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::MenuItem),
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,'PID'))
    $menu = $null
    foreach ($win in [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,$owner)) {
        $menu = $win.FindFirst([Windows.Automation.TreeScope]::Descendants,$cond)
        if ($menu) { break }
    }
    if ($menu -and $menu.Current.ControlType -eq [Windows.Automation.ControlType]::MenuItem -and !$menu.Current.IsOffscreen) {
        $invoke = $null
        if ($menu.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$invoke)) { $invoke.Invoke() }
        else { $menu.SetFocus(); [Windows.Forms.SendKeys]::SendWait('{ENTER}') }
    } else { Assert-Foreground; [Windows.Forms.SendKeys]::SendWait('{ESC}') }
    Start-Sleep -Milliseconds 350
}
function Match-Target($row,$target,$inventory,$header) {
    $p = $target.record
    $rx = if ($p.Name -eq 'node.exe') { '(?i)^(?:Name\s*:\s*)?(?:Node\.js(?: JavaScript Runtime|: Server-side JavaScript)?|node(?:\.exe)?)(?:$|\s*[,;])' }
        else { '(?i)^(?:Name\s*:\s*)?Python(?:\s+\d+(?:\.\d+)*|\.exe)?(?:$|\s*[,;])' }
    if (!($row.names -match $rx)) { return $false }
    $pidText = "$($p.ProcessId)"
    if ($row.names -match "(?i)\b(?:PID|Process ID)\s*:\s*$pidText\b") { return $true }
    if ($header) {
        foreach ($cell in $row.cells) {
            $center = $cell.x + $cell.w/2
            if ($cell.name -ceq $pidText -and $center -ge $header.x -and $center -lt $header.x+$header.w) { return $true }
        }
    }
    # No arbitrary number matching. If no PID is exposed, the executable family must be unique
    # in the runner session at BOTH captures, and be the same live packaged PID.
    $family = if ($p.Name -eq 'node.exe') {'^node\.exe$'} else {'^pythonw?\.exe$'}
    foreach ($list in @{'start'=$before; 'now'=$inventory}.Values) {
        $matchesForFamily = @($list | Where-Object Name -match $family)
        if ($matchesForFamily.Count -ne 1 -or $matchesForFamily[0].ProcessId -ne $p.ProcessId -or $matchesForFamily[0].CreationDate -ne $p.CreationDate) { return $false }
    }
    return $true
}
function Get-TaskManagerProof {
    Start-Process "$env:WINDIR/System32/Taskmgr.exe"
    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 300
        $manager = Get-Process Taskmgr -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $sessionId -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    } until ($manager -or (Get-Date) -gt $deadline)
    if (!$manager) { throw 'Task Manager has no window on the runner session desktop' }
    $hwnd = $manager.MainWindowHandle
    $report.taskManager = @{pid=$manager.Id; hwnd=$hwnd.ToInt64(); path=$manager.Path; version=$manager.FileVersion}
    $null = [ProbeDesktop]::ShowWindowAsync($hwnd,3) # maximize: more of the actual Processes list fits on screen
    $null = [ProbeDesktop]::SetForegroundWindow($hwnd)
    if ([ProbeDesktop]::GetForegroundWindow() -ne $hwnd) { $null = (New-Object -ComObject WScript.Shell).AppActivate($manager.Id) }
    Start-Sleep -Seconds 1
    Save-Screen 'taskmgr-opened'
    Assert-Foreground
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
    $cache = [Windows.Automation.CacheRequest]::new()
    $cache.TreeScope = [Windows.Automation.TreeScope]::Subtree
    $cache.TreeFilter = [Windows.Automation.Automation]::RawViewCondition
    foreach ($property in 'ControlType','AutomationId','Name','BoundingRectangle','IsOffscreen') {
        $propName = "${property}Property"; $cache.Add([Windows.Automation.AutomationElement]::$propName)
    }
    $cache.Add([Windows.Automation.ExpandCollapsePattern]::ExpandCollapseStateProperty)
    $view = @(Save-View 'taskmgr-initial')
    $nav = $view | Where-Object { $_.visible -and $_.name -ceq 'Processes' -and $_.type -in 'ListItem','TabItem','Button','TreeItem' } | Select-Object -First 1
    if ($nav) { Click-Cell $nav; Start-Sleep -Milliseconds 550 }
    $view = @(Save-View 'processes')
    $apps = $view | Where-Object { $_.visible -and $_.name -match '^Apps(?:\s*\(\d+\)|:\s*\d+)?$' } | Select-Object -First 1
    if (!$apps) { throw 'Processes > Apps section not visibly identified; inspect the screenshots/UIA' }
    $lab = Find-Lab @(Get-Rows $view)
    if (!$lab) { throw 'App group row not visible in Task Manager' }
    $background = $view | Where-Object { $_.visible -and $_.name -match '^Background processes\b' } | Select-Object -First 1
    if ($lab.node.y -lt $apps.y -or ($background -and $lab.node.y -ge $background.y)) { throw 'Lab row is not visibly within the Apps section' }
    try { Enable-PidColumn $view $lab } catch {
        Note "Could not enable the optional PID column: $_"
        Assert-Foreground; [Windows.Forms.SendKeys]::SendWait('{ESC}')
    }
    $view = @(Save-View $null)
    $lab = Find-Lab @(Get-Rows $view)
    Set-LabOpen $lab $false
    $cv = @(Save-View '01-collapsed'); $cr = @(Get-Rows $cv); $c = Find-Lab $cr
    Set-LabOpen $c $true
    $ev = @(Save-View '02-expanded'); $er = @(Get-Rows $ev); $e = Find-Lab $er
    Set-LabOpen $e $false
    $fv = @(Save-View '03-recollapsed'); $fr = @(Get-Rows $fv); $f = Find-Lab $fr
    if (!$c -or !$e -or !$f) { throw 'Lab group did not remain identifiable across the three screenshots' }
    # Legacy Task Manager exposes flat TmViewRows. Establish insertion boundaries by the same
    # next visible row directly below the group in BOTH collapsed states, found farther down
    # in the expanded state. Never infer group membership from PID ancestry or mere proximity.
    $nextC = $cr | Where-Object { $_.node.y -gt $c.node.y } | Sort-Object { $_.node.y } | Select-Object -First 1
    $nextF = $fr | Where-Object { $_.node.y -gt $f.node.y } | Sort-Object { $_.node.y } | Select-Object -First 1
    $anchor = if ($nextC.label -and $nextC.label -ceq $nextF.label -and $c.node.y -eq $e.node.y -and $e.node.y -eq $f.node.y) {
        @($er | Where-Object { $_.node.y -gt $e.node.y -and $_.label -ceq $nextC.label } | Sort-Object { $_.node.y }) | Select-Object -First 1
    }
    $inside = @($er | Where-Object { $_.node.path.StartsWith($e.node.path+'.') -or
        ($anchor -and $_.node.y -gt $e.node.y -and $_.node.y -lt $anchor.node.y) })
    $stateProof = $c.node.state -eq 'Collapsed' -and $e.node.state -eq 'Expanded' -and $f.node.state -eq 'Collapsed'
    if (!$stateProof -and (!$anchor -or !$inside.Count -or $anchor.node.y -le $nextF.node.y)) { throw 'No unambiguous expand/recollapse transition: inspect the screenshots' }
    $report.transition = @{states=@($c.node.state,$e.node.state,$f.node.state); nextCollapsed=$nextC.label; insertedLabels=@($inside.label)}
    $live = @(Get-Inventory)
    Save-Json 'processes-during.json' $live
    $pidHeader = $ev | Where-Object { $_.name -ceq 'PID' -and $_.visible -and $_.y -lt $e.node.y } | Select-Object -First 1
    foreach ($t in $targets) {
        $insideRows = @($inside | Where-Object { Match-Target $_ $t $live $pidHeader })
        $outsideRows = @($fr | Where-Object { Match-Target $_ $t $live $pidHeader })
        $firstCollapsed = @($cr | Where-Object { Match-Target $_ $t $live $pidHeader })
        if ($insideRows.Count -eq 1 -and !$outsideRows.Count -and !$firstCollapsed.Count) {
            $report[$t.key]='yes'; $report.reasons[$t.key]="PID $($t.record.ProcessId): visible inside expanded group only; $($insideRows[0].node.path) in 02-expanded-uia.json."
        } elseif (!$insideRows.Count -and $outsideRows.Count -eq 1 -and $firstCollapsed.Count -eq 1) {
            $report[$t.key]='no'; $report.reasons[$t.key]="PID $($t.record.ProcessId): row visible with group closed before and after expansion; $($outsideRows[0].node.path) in 03-recollapsed-uia.json."
        }
    }
    Save-Json 'result.json' $report
    # An ungrouped interpreter may be below the fold. Scroll the actual, unfiltered Processes
    # page with the group still collapsed; a matched visible outside row is negative evidence.
    $unknown = @($targets | Where-Object { $report[$_.key] -eq 'inconclusive' })
    if (!$unknown.Count) { return }
    $null = [ProbeDesktop]::SetCursorPos(($f.node.x + 110),($f.node.y + [int]($f.node.h/2)))
    $prev = ''
    for ($i=1; $i -le 35; $i++) {
        Assert-Foreground
        [ProbeDesktop]::mouse_event(0x0800,0,0,-960,[UIntPtr]::Zero)
        Start-Sleep -Milliseconds 220
        $v = @(Save-View $null); $rs = @(Get-Rows $v); $sig = $rs.label -join '|'
        if ($sig -ceq $prev) { break }; $prev = $sig
        foreach ($t in $unknown) {
            if ($report[$t.key] -ne 'inconclusive') { continue }
            if ($rs | Where-Object { Match-Target $_ $t $live $pidHeader }) {
                $name = "outside-$i-$($t.key)"
                $v = @(Save-View $name)
                $now = @(Get-Inventory)
                $found = @(Get-Rows $v | Where-Object { Match-Target $_ $t $now $pidHeader })
                if ($found.Count -eq 1) {
                    $report[$t.key]='no'; $report.reasons[$t.key]="PID $($t.record.ProcessId): row visible on scrolling unfiltered Processes while group was closed; $($found[0].node.path) in $name-uia.json."
                }
            }
        }
        if (!($unknown | Where-Object {$report[$_.key] -eq 'inconclusive'})) { break }
    }
}
