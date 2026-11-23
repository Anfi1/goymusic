param([switch]$Worker,[switch]$Hosted,[guid]$RunId=[guid]::NewGuid())
$ErrorActionPreference='Stop'
$stage=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('GoyMusic-metadata-'+$RunId.ToString('N'))
$ps="$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$admin=([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($Hosted -and $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Hosted mode is limited to disposable Windows runners.' }
if (!$Worker) {
    if ($admin -and !$Hosted) { throw 'Double-click the CMD normally. Only the isolation controller needs UAC.' }
    if (!$Hosted) {
        Write-Host 'No install or downgrade. This creates one temporary standard Windows account. Only the private test player is restarted four times. Its account, profile and test files are removed afterward. Leave Task Manager on Processes; keep your normal player open.'
        if ((Read-Host 'Type YES to allow this temporary account and its cleanup') -cne 'YES') { return }
    }
    $argv="-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Worker -RunId $RunId"
    if ($Hosted) { $argv+=' -Hosted'; $p=Start-Process $ps -ArgumentList $argv -PassThru -Wait -NoNewWindow } else { $p=Start-Process $ps -ArgumentList $argv -Verb RunAs -PassThru -Wait }
    if (Test-Path "$stage/result.json") {
        $dest=Join-Path $PSScriptRoot 'metadata-result.json'; Copy-Item -LiteralPath "$stage/result.json" -Destination $dest
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
$result=[ordered]@{version='7.1.16';status='incomplete';runs=@();originalWindows=$baseline.Count;originalsStillRunning=$null;cleanupComplete=$false}
$user=$null; $launcher=$null; $pw=$null; $app=$null
try {
    Write-Host 'Downloading the official 7.1.16 test payload (185 MiB). No installer is run.'
    $url='https://github.com/Anfi1/goymusic/releases/download/v7.1.16/GoyMusic-Setup-7.1.16.exe'
    & "$env:SystemRoot\System32\curl.exe" -q --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 600 --range '525785-194096880' --output "$stage/app-64.7z" $url
    if ($LASTEXITCODE) { throw 'Cannot download the test payload. The installed player was not changed.' }
    if ((Get-FileHash "$stage/app-64.7z").Hash -ne 'a7dbe1c2cff1605d4936241e3429025092575eb410c1f9f2e8f4d7a61d523a2c') { throw 'Unexpected official payload.' }
    & "$env:WINDIR\System32\tar.exe" -xf "$stage/app-64.7z" -C $dir; if ($LASTEXITCODE) { throw 'Cannot unpack official payload.' }
    $stock="$stage/stock.exe"; $variant="$stage/variant.exe"
    $stockHash='d3103c1cdc872ced73288828511a6b0382ca96fd1766d5c39f468a6f2dfe5159'
    if ((Get-FileHash $exe).Hash -ne $stockHash) { throw 'Not the official 7.1.16 executable.' }
    Copy-Item $exe $stock; Copy-Item $exe $variant
    # Меняем только RT_VERSION/1/1033 в копии, не в установленном EXE.
    Add-Type @'
using System; using System.ComponentModel; using System.Runtime.InteropServices;
public static class GoyVersionResource {
 [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr BeginUpdateResource(string file,bool deleteExisting);
 [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool UpdateResource(IntPtr h,IntPtr type,IntPtr id,ushort lang,byte[] data,uint size);
 [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool EndUpdateResource(IntPtr h,bool discard);
 public static void Set(string file,byte[] data){
  var h=BeginUpdateResource(file,false); if(h==IntPtr.Zero)throw new Win32Exception();
  if(!UpdateResource(h,(IntPtr)16,(IntPtr)1,1033,data,(uint)data.Length)){var e=new Win32Exception();EndUpdateResource(h,true);throw e;}
  if(!EndUpdateResource(h,false))throw new Win32Exception();
 }
}
'@
    $versionBlob='7AI0AAAAVgBTAF8AVgBFAFIAUwBJAE8ATgBfAEkATgBGAE8AAAAAAL0E7/4AAAEAAQAHAAAAEAABAAcAAAAQAD8AAAAAAAAABAAEAAEAAAAAAAAAAAAAAAAAAABMAgAAAQBTAHQAcgBpAG4AZwBGAGkAbABlAEkAbgBmAG8AAAAoAgAAAQAwADQAMAA5ADAANABiADAAAAA0AAkAAQBDAG8AbQBwAGEAbgB5AE4AYQBtAGUAAAAAAEcAbwB5AE0AdQBzAGkAYwAAAAAAPAAJAAEARgBpAGwAZQBEAGUAcwBjAHIAaQBwAHQAaQBvAG4AAAAAAEcAbwB5AE0AdQBzAGkAYwAAAAAAMAAHAAEARgBpAGwAZQBWAGUAcgBzAGkAbwBuAAAAAAA3AC4AMQAuADEANgAAAAAANAAJAAEASQBuAHQAZQByAG4AYQBsAE4AYQBtAGUAAABHAG8AeQBNAHUAcwBpAGMAAAAAAFgAGgABAEwAZQBnAGEAbABDAG8AcAB5AHIAaQBnAGgAdAAAAEMAbwBwAHkAcgBpAGcAaAB0ACAAqQAgADIAMAAyADYAIABHAG8AeQBNAHUAcwBpAGMAAABEAA0AAQBPAHIAaQBnAGkAbgBhAGwARgBpAGwAZQBuAGEAbQBlAAAARwBvAHkATQB1AHMAaQBjAC4AZQB4AGUAAAAAADQACQABAFAAcgBvAGQAdQBjAHQATgBhAG0AZQAAAAAARwBvAHkATQB1AHMAaQBjAAAAAAA4AAkAAQBQAHIAbwBkAHUAYwB0AFYAZQByAHMAaQBvAG4AAAA3AC4AMQAuADEANgAuADAAAAAAADQAAgABAFMAcQB1AGkAcgByAGUAbABBAHcAYQByAGUAVgBlAHIAcwBpAG8AbgAAADEAAABEAAAAAQBWAGEAcgBGAGkAbABlAEkAbgBmAG8AAAAAACQABAAAAFQAcgBhAG4AcwBsAGEAdABpAG8AbgAAAAAACQSwBA=='
    [GoyVersionResource]::Set($variant,[Convert]::FromBase64String($versionBlob))
    $variantHash=(Get-FileHash $variant).Hash
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
if (!$env:APPDATA -or !$env:LOCALAPPDATA -or !(Test-Path 'Registry::HKEY_USERS\__SID__')) { throw 'Temporary user profile not loaded.' }
$exe=Join-Path $PSScriptRoot 'player\GoyMusic.exe'; $app=Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -PassThru; $app.WaitForExit()
'@
    [IO.File]::WriteAllText("$stage/launch.ps1",$child.Replace('__SID__',$user.SID.Value),$utf8)
    $cred=[Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$name",$pw)
    foreach ($mode in 'A1','B1','A2','B2') {
    $isStock=$mode[0] -eq 'A'
    $source=if ($isStock) {$stock} else {$variant}
    $expected=if ($isStock) {$stockHash} else {$variantHash}
    Copy-Item -LiteralPath $source -Destination $exe -Force
    $vi=[Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
    if ((Get-FileHash $exe).Hash -ne $expected -or $vi.ProductVersion -ne '7.1.16.0' -or ($isStock -and ($vi.CompanyName -ne 'GitHub, Inc.' -or $vi.OriginalFilename)) -or (!$isStock -and ($vi.CompanyName -ne 'GoyMusic' -or $vi.OriginalFilename -ne 'GoyMusic.exe'))) { throw "Wrong executable metadata in $mode" }
    $run=[ordered]@{mode=$mode;company=$vi.CompanyName;originalFilename=$vi.OriginalFilename;status='unmeasured';samples=@()}
    $launcher=Start-Process $ps -Credential $cred -LoadUserProfile -WorkingDirectory $dir -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$stage/launch.ps1`"" -PassThru
    for ($i=0;$i -lt 60;$i++) {
        $app=Get-Process GoyMusic -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe -and $_.SessionId -eq $session -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($app) {break}; if ($launcher.HasExited) {throw 'Temporary account could not start the player.'}; Start-Sleep -Seconds 1
    }
    if (!$app) { throw "No test window in $mode" }
    $run.mainPid=$app.Id; Write-Host "${mode}: test PID $($app.Id). Keep Task Manager on Processes."
    Start-Sleep -Seconds 30
    & $ps -NoProfile -ExecutionPolicy Bypass -File $observer -OutFile "$stage/raw.json"; if ($LASTEXITCODE) { throw 'Task Manager reader failed.' }
    $raw=Get-Content "$stage/raw.json" -Raw | ConvertFrom-Json; $result.taskManagerVersion=$raw.taskManagerVersion
    foreach ($s in $raw.samples) {
        $root=@($s.processes | Where-Object { $_.pid -eq $app.Id -and $_.role -eq 'main' -and $_.elevated -eq 'no' }); $state='unmeasured'; $rows=@(); $largest=0
        if ($root.Count -eq 1 -and $root[0].install -ne 'unknown') {
            $rows=@($s.processes | Where-Object install -eq $root[0].install)
            if (!$s.uiError -and $rows.role -contains 'renderer' -and !@($rows | Where-Object { !$_.taskManagerRows.Count -or ($_.pid -ne $app.Id -and $_.parent -ne $app.Id) }).Count) {
                $groups=@(foreach ($r in $rows) { $t=$r.taskManagerRows[0]; if ($t.parentGoyMusicRow) {$t.parentGoyMusicRow} else {$t.row} }); $largest=($groups|Group-Object|Sort-Object Count -Descending|Select-Object -First 1).Count
                $otherGroups=@(foreach ($r in $s.processes) { if ($r.pid -notin $rows.pid) { foreach ($t in $r.taskManagerRows) { if ($t.parentGoyMusicRow) {$t.parentGoyMusicRow} else {$t.row} } } })
                if (!@($groups | Where-Object { $_ -in $otherGroups }).Count) {
                    $state=if ($largest -eq $rows.Count) {'grouped'} elseif ($largest -eq 1) {'separate'} else {'partial'}
                }
            }
        }
        $run.samples+=@([pscustomobject]@{status=$state;largest=$largest;total=$rows.Count;pids=@($rows.pid);uiError=$s.uiError})
    }
    $a,$b=$run.samples
    if ($a -and $b -and $a.status -eq $b.status -and $a.largest -eq $b.largest -and ($a.pids -join ',') -eq ($b.pids -join ',')) { $run.status=$b.status }
    $result.runs+=@([pscustomobject]$run)
    Write-Host "${mode}: $($run.status)"
    if (!$app.HasExited -and (!$app.CloseMainWindow() -or !$app.WaitForExit(20000))) { throw 'Cannot cleanly close the test copy.' }
    if (!$launcher.WaitForExit(15000)) { throw 'Test launcher did not exit.' }
    $deadline=[datetime]::UtcNow.AddSeconds(15)
    while (Get-Process GoyMusic -ErrorAction SilentlyContinue | Where-Object Path -eq $exe) {
        if ([datetime]::UtcNow -gt $deadline) { throw 'Test helpers still running.' }; Start-Sleep -Milliseconds 250
    }
    }
    $states=$result.runs.status -join ','
    $result.status=if ($states -eq 'separate,grouped,separate,grouped' -or $states -eq 'partial,grouped,partial,grouped') {'metadata-effect'} elseif ($states -eq 'separate,separate,separate,separate') {'no-effect'} elseif ($states -eq 'grouped,grouped,grouped,grouped') {'baseline-already-grouped'} else {'inconclusive'}
} catch { $result.error=$_.Exception.Message; Write-Host "ERROR: $($result.error)" }
finally {
    try {
        if ($app -and !$app.HasExited) { $null=$app.CloseMainWindow(); $null=$app.WaitForExit(8000) }
        if ($user) {
            # Только процессы SID, созданного этим запуском, включая оставшиеся скрытые окна старой версии.
            if ($launcher -and !$launcher.HasExited) { $null=$launcher.WaitForExit(3000) }
            $owned=@(Get-Process -IncludeUserName -ErrorAction SilentlyContinue | Where-Object UserName -eq "$env:COMPUTERNAME\$name")
            foreach ($proc in $owned) { if (!$proc.HasExited) { $proc.Kill(); $null=$proc.WaitForExit(5000) } }
            $sid=$user.SID.Value; Remove-LocalUser -SID $user.SID
            $profile=Get-CimInstance Win32_UserProfile -Filter "SID='$sid'"
            for ($i=0;$profile -and $profile.Loaded -and $i -lt 25;$i++) { Start-Sleep -Seconds 1; $profile=Get-CimInstance Win32_UserProfile -Filter "SID='$sid'" }
            if ($profile -and ($profile.Loaded -or $profile.Special)) { throw "Temporary profile in use: $sid. No other profile touched." }
            if ($profile) { $profile | Remove-CimInstance }
        }
        if ($pw) { $pw.Dispose() }
        foreach ($n in 'player','app-64.7z','stock.exe','variant.exe','launch.ps1','observe.ps1','raw.json') { $f=Join-Path $stage $n; if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Recurse -Force } }
        $result.cleanupComplete=$true
    } catch { $result.cleanupError=$_.Exception.Message; Write-Host "Cleanup: $($result.cleanupError)" }
    $result.originalsStillRunning=@(foreach ($r in $baseline) { $q=Get-Process -Id $r.pid -ErrorAction SilentlyContinue; if ($q -and $q.StartTime -eq $r.time) { $q.Id } }).Count
    $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$stage/result.json" -Encoding UTF8
}
if ($result.error -or !$result.cleanupComplete) { exit 1 }
