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
function Get-NestedVerdict($view, $target) {
    $groups = @($view | Where-Object { $_.type -eq 'Group' -and $_.id -in 'TmGroupHeader_Apps','TmGroupHeader_Background','TmGroupHeader_Windows' })
    $labRows = @($view | Where-Object { $_.type -eq 'TreeItem' -and $_.state -in 'Expanded','Collapsed' -and $_.name -match '^GoyMusic MSIX Lab(?:\s*\(\d+\)|\.\s+\d+\s+instances?\.)?$' })
    if (!$groups.Count -or !$labRows.Count) { return }
    $suffix = ':' + $target.record.ProcessId
    $processName = if ($target.key -eq 'python') { '^python(?:\.exe|\b)' } else { '^node(?:\.exe|\.js|\b)' }
    $rows = @($view | Where-Object { $_.type -eq 'TreeItem' -and $_.id.EndsWith($suffix) -and $_.name -match $processName })
    if ($rows.Count -ne 1) { return }
    $row = $rows[0]
    $section = $groups | Where-Object { $row.path.StartsWith($_.path + '.') } | Select-Object -First 1
    if (!$section) { return }
    $parent = $labRows | Where-Object { $row.path.StartsWith($_.path + '.') } | Select-Object -First 1
    if ($parent) { $result = 'yes' }
    elseif ($row.path.Substring(0,$row.path.LastIndexOf('.')) -ceq $section.path) { $result = 'no' }
    else { return }
    [pscustomobject]@{result=$result; name=$row.name; row=$row.path; id=$row.id; section=$section.name; parent=$parent.path}
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
    # UIA can read a real Task Manager HWND even if the runner's Windows welcome screen has focus.
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
    $cache = [Windows.Automation.CacheRequest]::new()
    $cache.TreeScope = [Windows.Automation.TreeScope]::Subtree
    $cache.TreeFilter = [Windows.Automation.Automation]::RawViewCondition
    foreach ($property in 'ControlType','AutomationId','Name','BoundingRectangle','IsOffscreen') {
        $propName = "${property}Property"; $cache.Add([Windows.Automation.AutomationElement]::$propName)
    }
    $cache.Add([Windows.Automation.ExpandCollapsePattern]::ExpandCollapseStateProperty)
    $previous = @{}
    for ($i = 1; $i -le 6; $i++) {
        Start-Sleep -Seconds 3
        $view = @(Save-View "processes-$i")
        if (!($view | Where-Object { $_.id -eq 'ScrollViewer' -and $_.name -ceq 'Processes' })) { continue }
        foreach ($t in $targets) {
            $v = Get-NestedVerdict $view $t
            if ($v -and $previous[$t.key] -eq $v.result) {
                $report[$t.key] = $v.result
                $report.reasons[$t.key] = "Processes UIA sample $i and previous sample: $($v.section), $($v.name), automation ID $($v.id), row $($v.row), lab parent '$($v.parent)'."
            } else {
                $report[$t.key] = 'inconclusive'
            }
            $previous[$t.key] = $v.result
        }
        if ($targets.Count -eq 2 -and !($targets | Where-Object { $report[$_.key] -eq 'inconclusive' })) { break }
        foreach ($group in $view | Where-Object { $_.type -eq 'TreeItem' -and $_.name -match '^GoyMusic MSIX Lab' -and $_.state -eq 'Collapsed' }) {
            $pattern = $null
            if ($group.element.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$pattern)) { $pattern.Expand() }
        }
    }
}
