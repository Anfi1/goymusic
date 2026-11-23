# The controller and every GoyMusic process stay at the normal user's integrity level.
param([string]$CiPipeName,[int]$CiObserverPid)
$ErrorActionPreference='Stop'
$admin=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($admin) { throw 'Run the CMD normally, NOT as administrator. Only the separate Task Manager reader needs UAC.' }
. "$PSScriptRoot/group-trial-launch.ps1"
[GoyMusic.GroupTrialLauncher]::RequireUnelevated()
$ciMode=[bool]$CiPipeName
if ($ciMode -and ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $CiPipeName -notmatch '^goy-group-[a-f0-9]{32}$' -or $CiObserverPid -le 0)) { throw 'Unexpected CI options' }
$session=(Get-Process -Id $PID).SessionId
$roots=@(Get-CimInstance Win32_Process -Filter "Name='GoyMusic.exe' AND SessionId=$session" | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '(?:^|\s)"?--type=' -and $_.ExecutablePath })
if ($roots.Count -ne 1) { throw 'Open one installed GoyMusic player normally, then retry.' }
if ($roots[0].CommandLine -match '--user-data-dir|goymusic://') { throw 'Start the player normally from Start before running the comparison.' }
$exe=$roots[0].ExecutablePath
if ((Get-Item $exe).VersionInfo.ProductName -ne 'GoyMusic') { throw 'Not the installed player.' }
$initial=Get-Process -Id $roots[0].ProcessId
$wsh=New-Object -ComObject WScript.Shell
$link=@(foreach ($folder in 'Programs','CommonPrograms') {
    Get-ChildItem ([Environment]::GetFolderPath($folder)) -Recurse -File -Filter GoyMusic.lnk -ErrorAction SilentlyContinue | Where-Object { $s=$wsh.CreateShortcut($_.FullName); $s.TargetPath -eq $exe -and !$s.Arguments }
}) | Select-Object -First 1
if (!$link) { throw 'Matching installed Start menu shortcut not found.' }
function Assert-NoInstall {
    if ((Test-Path "$env:TEMP/com.goymusic.app.update-lock") -or (Get-Process -Name 'GoyMusic-Setup-*','Uninstall GoyMusic' -ErrorAction SilentlyContinue)) { throw 'An installation is in progress. Finish it before testing.' }
    $ver=(Get-Item $exe).VersionInfo.ProductVersion -replace '\.0$',''
    $pending=@(Get-ChildItem "$env:LOCALAPPDATA/goymusic-updater/pending" -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'temp-*' -or ($_.Extension -eq '.exe' -and $_.Name -ne "GoyMusic-Setup-$ver.exe") })
    if ($pending) { throw 'An update is staged. This tool will not close an app with a pending install.' }
}
Assert-NoInstall
if (!$ciMode) {
    Write-Host 'Open Task Manager > Processes, sorted by Memory descending. Keep the player window visible.'
    Write-Host 'This comparison pauses playback and closes/reopens the same player normally several times. No install or certificate.'
    if ((Read-Host 'Type Y to start') -ne 'Y') { return }
}
$pipeName=if ($ciMode) { $CiPipeName } else { 'goy-group-'+[guid]::NewGuid().ToString('N') }
$pipe=[IO.Pipes.NamedPipeServerStream]::new($pipeName,[IO.Pipes.PipeDirection]::InOut,1,[IO.Pipes.PipeTransmissionMode]::Byte,[IO.Pipes.PipeOptions]::Asynchronous)
Add-Type @'
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class TrialClient {
    [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetNamedPipeClientProcessId(SafePipeHandle handle,out uint pid);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr hwnd,int command);
}
'@
$result=[ordered]@{os=[Environment]::OSVersion.Version.ToString();version=(Get-Item $exe).VersionInfo.ProductVersion; verdict='inconclusive'; winner=$null; runs=@()}
$reportPath=Join-Path $PSScriptRoot 'group-trial-result.json'
$live=$initial; $needsRestore=$false; $keep=$false
function Save-Report { $result | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -LiteralPath $reportPath }
function Read-Reply {
    $pending=$reader.ReadLineAsync()
    if (!$pending.Wait(30000)) { throw 'Task Manager reader timed out' }
    $line=$pending.Result
    if (!$line) { throw 'Task Manager reader disconnected' }
    $line | ConvertFrom-Json
}
function Observe($tag,$p) {
    Write-Host "Measuring: $tag"
    $pair=@(foreach ($i in 1,2) {
        if ($i -eq 2) { Start-Sleep -Seconds 3 }
        $label="$tag-$i"; $q=@{sample=$label;pid=$p.Id;startedUtcTicks=[string]$p.StartTime.ToUniversalTime().Ticks}
        $writer.WriteLine(($q|ConvertTo-Json -Compress)); $a=Read-Reply
        if ($a.sample -ne $label) { throw 'Mismatched observer reply' }; $a
    })
    $state=if ($pair[0].status -eq $pair[1].status -and $pair[0].windowState -eq $pair[1].windowState -and
        ($pair[0].inventory.startedUtcTicks -join ',') -ceq ($pair[1].inventory.startedUtcTicks -join ',') -and
        $pair[1].mainElevated -eq 'no') { $pair[1].status } else { 'inconclusive' }
    $result.runs+=@([pscustomobject]@{run=$tag;status=$state;samples=$pair}); Save-Report
    Write-Host "${tag}: $state ($($pair[1].grouped)/$($pair[1].total))"
    $state
}
function Close-Trial($p) {
    Assert-NoInstall
    if (!$p.HasExited) { $p.Refresh(); if (!$p.CloseMainWindow() -or !$p.WaitForExit(20000)) { throw 'Player did not close normally. No process was killed.' } }
    Start-Sleep -Seconds 2
}
function Switch-Mode($mode,$tag) {
    Close-Trial $script:live; $script:needsRestore=$true
    $script:live=Start-TrialPlayer $exe $null $mode
    Start-Sleep -Seconds 32
    if ($script:live.HasExited) { throw "Player exited during $tag" }
    Observe $tag $script:live
}
try {
    $connect=$pipe.BeginWaitForConnection($null,$null)
    if ($ciMode) { $expected=$CiObserverPid } else {
        $observer=Start-Process "$PSHOME/powershell.exe" -Verb RunAs -PassThru -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$PSScriptRoot/group-trial-observe.ps1`" -PipeName $pipeName"
        $expected=$observer.Id
    }
    if (!$connect.AsyncWaitHandle.WaitOne(45000)) { throw 'Cannot connect to the read-only Task Manager observer' }; $pipe.EndWaitForConnection($connect)
    [uint32]$client=0
    if (![TrialClient]::GetNamedPipeClientProcessId($pipe.SafePipeHandle,[ref]$client) -or $client -ne $expected) { throw 'Unexpected observer process' }
    $utf8=[Text.UTF8Encoding]::new($false); $reader=[IO.StreamReader]::new($pipe,$utf8); $writer=[IO.StreamWriter]::new($pipe,$utf8); $writer.AutoFlush=$true
    if (!(Read-Reply).ready) { throw 'Observer failed to initialize' }
    $actual=Observe 'original' $initial
    if ($actual -eq 'inconclusive') { throw "Original measurement inconclusive: $($result.runs[-1].samples[-1].issues -join ','). Player left running." }
    if ($actual -eq 'grouped' -and !$ciMode) { $result.verdict='already-grouped'; return }
    if ($actual -eq 'separate' -and $result.runs[-1].samples[-1].windowState -eq 'minimized') {
        $null=[TrialClient]::ShowWindowAsync($initial.MainWindowHandle,9)
        Start-Sleep -Seconds 4
        if ((Observe 'restored-window' $initial) -eq 'grouped') {
            $null=[TrialClient]::ShowWindowAsync($initial.MainWindowHandle,6)
            Start-Sleep -Seconds 4
            $min=Observe 'minimized-again' $initial
            $null=[TrialClient]::ShowWindowAsync($initial.MainWindowHandle,9)
            Start-Sleep -Seconds 4
            if ((Observe 'restored-again' $initial) -eq 'grouped' -and $min -eq 'separate') { $result.verdict='repeatable-window-state-effect'; return }
        }
    }
    $baseline=Switch-Mode 'plain' 'plain'
    if ($baseline -eq 'grouped' -and !$ciMode) { $result.verdict='ordinary-relaunch-grouped'; $keep=$true; return }
    foreach ($mode in 'appid','job','both') {
        $test=Switch-Mode $mode $mode
        if ($baseline -eq 'separate' -and $test -eq 'grouped') {
            $reverse=Switch-Mode 'plain' "control-after-$mode"
            $again=Switch-Mode $mode "repeat-$mode"
            if ($reverse -eq 'separate' -and $again -eq 'grouped') { $result.verdict='repeatable-launch-effect'; $result.winner=$mode; $keep=$true; break }
            $baseline=$reverse
        }
    }
    if (!$keep) { $result.verdict='no-repeatable-launch-effect' }
} catch { $result.error=$_.Exception.Message; throw }
finally {
    if ($writer) { try { $writer.WriteLine('{"stop":true}') } catch {} }
    $pipe.Dispose()
    if ($needsRestore -and !$keep) {
        if ($live -and !$live.HasExited) { Close-Trial $live }
        Start-Process $link.FullName
    }
    Save-Report
    Write-Host "Result: $($result.verdict). Report: $reportPath"
}
