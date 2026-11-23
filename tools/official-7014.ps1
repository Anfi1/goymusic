param([switch]$Worker,[switch]$Hosted,[guid]$RunId=[guid]::NewGuid())
$ErrorActionPreference='Stop'
$stage=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('GoyMusic-7014-'+$RunId.ToString('N'))
$ps="$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$admin=([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($Hosted -and $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Hosted mode is limited to disposable Windows runners.' }
if (!$Worker) {
    if ($admin -and !$Hosted) { throw 'Double-click the CMD normally. Only the isolation controller needs UAC.' }
    if (!$Hosted) {
        Write-Host 'No installation or downgrade. This test temporarily creates a standard local Windows user, runs the official player as that user, then removes only that new user, its profile and test files. Your installed player stays open.'
        if ((Read-Host 'Type YES to allow this temporary account and its cleanup') -cne 'YES') { return }
    }
    $argv="-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Worker -RunId $RunId"
    if ($Hosted) { $argv+=' -Hosted'; $p=Start-Process $ps -ArgumentList $argv -PassThru -Wait -NoNewWindow } else { $p=Start-Process $ps -ArgumentList $argv -Verb RunAs -PassThru -Wait }
    if (Test-Path "$stage/result.json") {
        $dest=Join-Path $PSScriptRoot 'official-7014-result.json'; Copy-Item -LiteralPath "$stage/result.json" -Destination $dest
        Get-Content $dest -Raw; Write-Host "Report: $dest"
    }
    if ($p.ExitCode) { throw "Isolation controller exited with code $($p.ExitCode)." }; return
}
if (!$admin) { throw 'Isolation controller requires elevation.' }
$env:PSModulePath="$env:WINDIR\System32\WindowsPowerShell\v1.0\Modules"
# Не извлекать архив в каталог, доступный на запись другим пользователям.
if ([IO.Directory]::Exists($stage) -or [IO.File]::Exists($stage)) { throw 'Run directory already exists.' }
$acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true,$false)
foreach ($entry in @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@('S-1-5-32-545','ReadAndExecute'))) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($entry[0]),$entry[1],'ContainerInherit,ObjectInherit','None','Allow'))
}
# CreateDirectoryW fails if someone created the directory first (unlike Directory.CreateDirectory).
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class GoyPrivateDir {
 [StructLayout(LayoutKind.Sequential)] struct SA {public int size; public IntPtr descriptor; public int inherit;}
 [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectory(string path,ref SA attr);
 public static void Create(string path,byte[] sd){ var pin=GCHandle.Alloc(sd,GCHandleType.Pinned);try{var a=new SA{size=Marshal.SizeOf(typeof(SA)),descriptor=pin.AddrOfPinnedObject()};if(!CreateDirectory(path,ref a))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}finally{pin.Free();}}
}
'@
[GoyPrivateDir]::Create($stage,$acl.GetSecurityDescriptorBinaryForm()); $dir=Join-Path $stage 'player'; $exe=Join-Path $dir 'GoyMusic.exe'
$null=New-Item -ItemType Directory $dir
$session=(Get-Process -Id $PID).SessionId
$baseline=@(Get-Process GoyMusic -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session -and $_.MainWindowHandle -ne 0 } | ForEach-Object { [pscustomobject]@{pid=$_.Id;time=$_.StartTime} })
$result=[ordered]@{version='7.0.14';status='unmeasured';samples=@();originalWindows=$baseline.Count;originalsStillRunning=$null;cleanupComplete=$false}
$user=$null; $worker=$null; $pw=$null; $app=$null
try {
    Copy-Item -LiteralPath "$PSScriptRoot/app-64.7z" -Destination "$stage/app-64.7z"
    if ((Get-FileHash "$stage/app-64.7z").Hash -ne 'F0CD37C1F84616162F1BE65DDEA21FA7685395EED474096F31E05AD2B440D16D') { throw 'Unexpected official payload.' }
    & "$env:WINDIR\System32\tar.exe" -xf "$stage/app-64.7z" -C $dir; if ($LASTEXITCODE) { throw 'Cannot unpack official payload.' }
    $vi=(Get-Item $exe).VersionInfo; if ("$($vi.ProductMajorPart).$($vi.ProductMinorPart).$($vi.ProductBuildPart)" -ne '7.0.14') { throw 'Wrong application version.' }
    $observer="$stage/observe.ps1"; $utf8=[Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText($observer,[IO.File]::ReadAllText("$PSScriptRoot/check-goymusic-group.ps1").Replace("`r`n","`n"),$utf8)
    if ((Get-FileHash $observer).Hash -ne 'F7A5B2F9109BF9F81B05F16DEE55E884851B63B57048E52FA17E8FEef4afbe32') { throw 'Unexpected observer.' }
    $bytes=New-Object byte[] 36; $rng=[Security.Cryptography.RandomNumberGenerator]::Create(); try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $pw=ConvertTo-SecureString ('aA1!'+[Convert]::ToBase64String($bytes)) -AsPlainText -Force; [Array]::Clear($bytes,0,$bytes.Length)
    $name='GoyLab'+$RunId.ToString('N').Substring(0,10); $user=New-LocalUser -Name $name -Password $pw -Description 'Temporary GoyMusic grouping test' -AccountExpires (Get-Date).AddHours(2)
    if ($user.SID.Value -notin (Get-LocalGroupMember -SID S-1-5-32-545).SID.Value) { Add-LocalGroupMember -SID S-1-5-32-545 -Member $user }
    $child=@'
$ErrorActionPreference='Stop'
$id=[Security.Principal.WindowsIdentity]::GetCurrent()
if ($id.User.Value -ne '__SID__' -or ([Security.Principal.WindowsPrincipal]::new($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Not the temporary standard user.' }
$env:USERPROFILE=[Environment]::GetFolderPath('UserProfile'); $env:APPDATA=[Environment]::GetFolderPath('ApplicationData'); $env:LOCALAPPDATA=[Environment]::GetFolderPath('LocalApplicationData'); $env:TEMP=$env:TMP=Join-Path $env:LOCALAPPDATA 'Temp'
if (!$env:APPDATA -or !$env:LOCALAPPDATA -or (Test-Path (Join-Path $env:APPDATA 'GoyMusic')) -or (Test-Path HKCU:\Software\Classes\goymusic)) { throw 'Expected a fresh user profile.' }
$exe=Join-Path $PSScriptRoot 'player\GoyMusic.exe'; $app=Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -PassThru; $app.WaitForExit()
'@
    [IO.File]::WriteAllText("$stage/launch.ps1",$child.Replace('__SID__',$user.SID.Value),$utf8)
    $cred=[Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$name",$pw)
    $worker=Start-Process $ps -Credential $cred -LoadUserProfile -WorkingDirectory $dir -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$stage/launch.ps1`"" -PassThru
    for ($i=0;$i -lt 60;$i++) {
        $app=Get-Process GoyMusic -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe -and $_.SessionId -eq $session -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($app) {break}; if ($worker.HasExited) {throw 'Temporary account could not start the player.'}; Start-Sleep -Seconds 1
    }
    if (!$app) { throw 'No 7.0.14 window on the interactive desktop.' }
    $result.mainPid=$app.Id; Write-Host "Official 7.0.14 PID: $($app.Id). Do not sign in or click Update. Open Task Manager > Processes."
    Start-Sleep -Seconds 30
    & $ps -NoProfile -ExecutionPolicy Bypass -File $observer -OutFile "$stage/raw.json"; if ($LASTEXITCODE) { throw 'Task Manager reader failed.' }
    $raw=Get-Content "$stage/raw.json" -Raw | ConvertFrom-Json; $result.taskManagerVersion=$raw.taskManagerVersion
    foreach ($s in $raw.samples) {
        $root=@($s.processes | Where-Object { $_.pid -eq $app.Id -and $_.role -eq 'main' -and $_.elevated -eq 'no' }); $state='unmeasured'; $rows=@(); $largest=0
        if ($root.Count -eq 1 -and $root[0].install -ne 'unknown') {
            $rows=@($s.processes | Where-Object install -eq $root[0].install)
            if (!$s.uiError -and $rows.role -contains 'renderer' -and !@($rows | Where-Object { !$_.taskManagerRows.Count -or ($_.pid -ne $app.Id -and $_.parent -ne $app.Id) }).Count) {
                $groups=@(foreach ($r in $rows) { $t=$r.taskManagerRows[0]; if ($t.parentGoyMusicRow) {$t.parentGoyMusicRow} else {$t.row} }); $largest=($groups|Group-Object|Sort-Object Count -Descending|Select-Object -First 1).Count
                $state=if ($largest -eq $rows.Count) {'grouped'} elseif ($largest -eq 1) {'separate'} else {'partial'}
            }
        }
        $result.samples+=@([pscustomobject]@{status=$state;largest=$largest;total=$rows.Count;pids=@($rows.pid);uiError=$s.uiError})
    }
    $a,$b=$result.samples
    if ($a -and $b -and $a.status -eq $b.status -and $a.largest -eq $b.largest -and ($a.pids -join ',') -eq ($b.pids -join ',')) { $result.status=$b.status }
    Write-Host "Automatic result: $($result.status). Test PID: $($app.Id)"
    if (!$Hosted) { $null=Read-Host 'Look at the test player in Task Manager. Press Enter to close ONLY the test copy and remove the temporary account' }
    if ($Hosted -and $result.status -eq 'unmeasured') { throw 'No verified Task Manager observation.' }
} catch { $result.error=$_.Exception.Message; Write-Host "ERROR: $($result.error)" }
finally {
    try {
        if ($app -and !$app.HasExited) { $null=$app.CloseMainWindow(); $null=$app.WaitForExit(8000) }
        if ($user) {
            # Только процессы SID, созданного этим запуском, включая оставшиеся скрытые окна старой версии.
            $owned=@(Get-Process -IncludeUserName -ErrorAction SilentlyContinue | Where-Object UserName -eq "$env:COMPUTERNAME\$name")
            foreach ($proc in $owned) { if (!$proc.HasExited) { $proc.Kill(); $null=$proc.WaitForExit(5000) } }
            $sid=$user.SID.Value; Remove-LocalUser -SID $user.SID
            $profile=Get-CimInstance Win32_UserProfile -Filter "SID='$sid'"
            for ($i=0;$profile -and $profile.Loaded -and $i -lt 25;$i++) { Start-Sleep -Seconds 1; $profile=Get-CimInstance Win32_UserProfile -Filter "SID='$sid'" }
            if ($profile -and ($profile.Loaded -or $profile.Special)) { throw "Temporary profile in use: $sid. No other profile touched." }
            if ($profile) { $profile | Remove-CimInstance }
        }
        if ($pw) { $pw.Dispose() }
        foreach ($n in 'player','app-64.7z','launch.ps1','observe.ps1','raw.json') { $f=Join-Path $stage $n; if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Recurse -Force } }
        $result.cleanupComplete=$true
    } catch { $result.cleanupError=$_.Exception.Message; Write-Host "Cleanup: $($result.cleanupError)" }
    $result.originalsStillRunning=@(foreach ($r in $baseline) { $q=Get-Process -Id $r.pid -ErrorAction SilentlyContinue; if ($q -and $q.StartTime -eq $r.time) { $q.Id } }).Count
    $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$stage/result.json" -Encoding UTF8
}
if ($result.error -or !$result.cleanupComplete) { exit 1 }
