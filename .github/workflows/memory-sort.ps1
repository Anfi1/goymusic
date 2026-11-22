function Select-MemoryDescending([IntPtr]$hwnd) {
    $ErrorActionPreference = 'Stop'
    try {
        Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
        $root = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
        if ((Get-Process -Id $root.Current.ProcessId).ProcessName -ne 'Taskmgr') { throw 'Not a Task Manager window' }
        function Find-Column($id) {
            $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
            $root.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
        }
        function Read-MemoryState {
            # Task Manager can replace the header after sorting; never reuse a cached name.
            $column = Find-Column 'TmColMemory'
            $caption = if ($column) { $column.Current.Name }
            if ($caption -match '(?s)^Memory\b.*?\bSorted\s*\(\s*(ascending|descending)\s*\)') { return $Matches[1] }
            if ($caption -match '^Memory\b') { return 'unsorted' }
            return 'absent'
        }
        function Show-Columns {
            foreach ($id in 'TmColFriendlyName','TmColMemory') {
                $column = Find-Column $id
                Write-Host "Task Manager ${id}: $($column.Current.Name)"
            }
        }
        for ($i = 0; $i -lt 24; $i++) {
            $state = Read-MemoryState
            if ($state -ne 'absent') { break }
            Start-Sleep -Milliseconds 250
        }
        Show-Columns
        if ($state -eq 'descending') { return $true }
        if ($state -eq 'absent') { return $false }

        foreach ($action in 'Invoke','DefaultAction','Enter','Click') {
            # A newly selected column may initially be ascending. Only toggle it again
            # with the same method if we observed that transition (not just a new %).
            for ($attempt = 0; $attempt -lt 2; $attempt++) {
                $state = Read-MemoryState
                if ($state -eq 'descending') { Show-Columns; return $true }
                $column = Find-Column 'TmColMemory'
                if (!$column) { break }
                try {
                    if ($action -eq 'Invoke') {
                        $pattern = $null
                        if (!$column.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { break }
                        $pattern.Invoke()
                    } else {
                        if (!('TaskmgrHeaderInput' -as [type])) {
                            Add-Type -TypeDefinition @'
using System;
using System.Reflection;
using System.Runtime.InteropServices;

public static class TaskmgrHeaderInput {
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [DllImport("user32")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32")] static extern IntPtr WindowFromPoint(Point pt);
    [DllImport("user32")] static extern IntPtr ChildWindowFromPointEx(IntPtr parent, Point pt, uint flags);
    [DllImport("user32")] static extern bool ScreenToClient(IntPtr window, ref Point pt);
    [DllImport("user32")] static extern bool IsChild(IntPtr parent, IntPtr window);
    [DllImport("user32")] static extern IntPtr SendMessageTimeoutW(IntPtr window, uint msg, IntPtr wp, IntPtr lp, uint flags, uint timeout, out UIntPtr result);
    [DllImport("oleacc")] static extern int AccessibleObjectFromPoint(Point pt, out IntPtr accessible, [MarshalAs(UnmanagedType.Struct)] out object child);
    [DllImport("oleacc")] static extern int WindowFromAccessibleObject(IntPtr accessible, out IntPtr window);

    static bool Within(IntPtr root, IntPtr target) { return target == root || IsChild(root, target); }
    static bool Send(IntPtr target, uint msg, int wp, int lp) {
        UIntPtr result;
        return SendMessageTimeoutW(target, msg, (IntPtr)wp, (IntPtr)lp, 2, 750, out result) != IntPtr.Zero;
    }
    public static bool Enter(IntPtr root, IntPtr target) {
        return Within(root, target) && Send(target, 0x100, 13, 0x1c0001) && Send(target, 0x101, 13, unchecked((int)0xc01c0001));
    }
    public static bool AtHeader(IntPtr root, int x, int y, bool legacy) {
        // UIA rectangles are in physical screen coordinates, even on scaled desktops.
        var previous = SetThreadDpiAwarenessContext((IntPtr)(-4));
        try {
            var screen = new Point { X = x, Y = y };
            if (legacy) {
                object child; IntPtr accessible, owner;
                if (!Within(root, WindowFromPoint(screen)) || AccessibleObjectFromPoint(screen, out accessible, out child) != 0) return false;
                try {
                    if (WindowFromAccessibleObject(accessible, out owner) != 0 || !Within(root, owner)) return false;
                    var acc = Marshal.GetObjectForIUnknown(accessible);
                    var args = new object[] { child };
                    var caption = acc.GetType().InvokeMember("accName", BindingFlags.GetProperty, null, acc, args) as string;
                    if (caption == null || !caption.StartsWith("Memory", StringComparison.OrdinalIgnoreCase)) return false;
                    acc.GetType().InvokeMember("accDoDefaultAction", BindingFlags.InvokeMethod, null, acc, args);
                    return true;
                } finally { Marshal.Release(accessible); }
            }
            // Descend *inside Task Manager*, not via the desktop. A Welcome overlay
            // must never receive a mouse press, even if it appears mid-action.
            var target = root;
            while (true) {
                var pt = screen;
                if (!ScreenToClient(target, ref pt)) return false;
                var child = ChildWindowFromPointEx(target, pt, 7); // skip invisible, disabled and transparent children
                if (child == IntPtr.Zero) return false;
                if (child == target) {
                    int lp = (pt.Y << 16) | (pt.X & 0xffff);
                    return Within(root, target) && Send(target, 0x201, 1, lp) && Send(target, 0x202, 0, lp);
                }
                target = child;
            }
        } finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
    }
}
'@
                        }
                        if ($action -eq 'Enter') {
                            $column.SetFocus()
                            $focused = [Windows.Automation.AutomationElement]::FocusedElement
                            if (![Windows.Automation.Automation]::Compare($column, $focused)) { break }
                            $walker = [Windows.Automation.TreeWalker]::RawViewWalker
                            while ($focused -and !$focused.Current.NativeWindowHandle) { $focused = $walker.GetParent($focused) }
                            if (!$focused -or ![TaskmgrHeaderInput]::Enter($hwnd, $focused.Current.NativeWindowHandle)) { break }
                        } else {
                            $r = $column.Current.BoundingRectangle
                            if ($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0) { break }
                            if (![TaskmgrHeaderInput]::AtHeader($hwnd, ($r.X + $r.Width / 2), ($r.Y + $r.Height / 2), ($action -eq 'DefaultAction'))) { break }
                        }
                    }
                } catch { Write-Host "Task Manager ${action}: $($_.Exception.Message)"; break }
                for ($i = 0; $i -lt 10; $i++) {
                    Start-Sleep -Milliseconds 200
                    $next = Read-MemoryState
                    if ($next -eq 'descending') { Show-Columns; return $true }
                    if ($next -eq 'ascending' -and $next -ne $state) { break }
                }
                Write-Host "Task Manager ${action}: $state -> $next"
                if ($next -ne 'ascending' -or $next -eq $state) { break }
            }
        }
        Show-Columns
        return ((Read-MemoryState) -eq 'descending')
    } catch { Write-Host "Task Manager Memory sort: $($_.Exception.Message)"; return $false }
}
