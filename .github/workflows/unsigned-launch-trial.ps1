$ErrorActionPreference='Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or (Get-CimInstance Win32_OperatingSystem).ProductType -ne 1) { throw 'Disposable Windows client required' }
$null=New-Item -ItemType Directory launch-results
$dir="$env:RUNNER_TEMP\GoyMusic unsigned trial"; $exe="$dir\GoyMusic.exe"
$setup="$env:RUNNER_TEMP\GoyMusic-Setup-7.1.15.exe"
Invoke-WebRequest 'https://github.com/Anfi1/goymusic/releases/download/v7.1.15/GoyMusic-Setup-7.1.15.exe' -OutFile $setup
if ([Convert]::ToBase64String([Convert]::FromHexString((Get-FileHash $setup -Algorithm SHA512).Hash)) -cne '/uqYTibZ3lAr4dUWKgk3Q6gGJf4MT70OiEjKjXmbKgaAI1eeLhexFD0fhi0Int33wyL9tsT6To/clEp+OqlXTw==') { throw 'Unexpected official EXE' }
$p=Start-Process $setup -ArgumentList '/S',"/D=$dir" -Wait -PassThru; if ($p.ExitCode) { throw 'Setup failed' }
Start-Process "$env:WINDIR\System32\Taskmgr.exe"
. "$PSScriptRoot/memory-sort.ps1"
Start-Sleep -Seconds 4
$t=Get-Process Taskmgr | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
if (!$t -or !(Select-MemoryDescending $t.MainWindowHandle)) { throw 'Descending Memory check failed' }
$pipe='goy-group-'+[guid]::NewGuid().ToString('N'); $task='GoyMusic limited token '+[guid]::NewGuid().ToString('N')
$folder=(New-Item -ItemType Directory "$env:PUBLIC\Documents\$pipe").FullName
$current=[Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls $folder /inheritance:r /grant:r ('{0}:(OI)(CI)F' -f $current) 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE) {throw 'Failed to restrict test work directory'}
Copy-Item ./tools/group-trial*.ps1 $folder
$ps="$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$env:PSModulePath="$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules;"+$env:PSModulePath
# PowerShell's normal installed modules must resolve inside the scheduled Windows PowerShell host as well.
$actionScript=@'
$ErrorActionPreference='Stop'
$env:RUNNER_ENVIRONMENT='github-hosted'
try {
    $app=Start-Process '__EXE__' -PassThru
    Start-Sleep -Seconds 32
    $observerNumber=Get-Content '__FOLDER__\observer.pid'
    & '__FOLDER__\group-trial.ps1' -CiPipeName '__PIPE__' -CiObserverPid ([int]$observerNumber)
    'ok' | Set-Content '__FOLDER__\finished'
} catch { ($_.Exception.Message+' '+$_.InvocationInfo.PositionMessage) | Set-Content '__FOLDER__\failed'; exit 1 }
'@
$actionScript.Replace('__EXE__',$exe).Replace('__FOLDER__',$folder).Replace('__PIPE__',$pipe) | Set-Content "$folder/controller.ps1" -Encoding utf8
$principal=New-ScheduledTaskPrincipal -UserId $current -LogonType Interactive -RunLevel Limited
$action=New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$folder/controller.ps1`""
$null=Register-ScheduledTask -TaskName $task -Action $action -Principal $principal
try {
    Start-ScheduledTask -TaskName $task
    Start-Sleep -Seconds 29
    $obs=Start-Process $ps -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$folder/group-trial-observe.ps1`" -PipeName $pipe" -PassThru -RedirectStandardError "$folder/observer.err"
    $obs.Id | Set-Content "$folder/observer.pid"
    $deadline=(Get-Date).AddMinutes(10)
    while ((Get-Date) -lt $deadline -and !(Test-Path "$folder/finished") -and !(Test-Path "$folder/failed")) {Start-Sleep -Seconds 3}
    if (Test-Path "$folder/group-trial-result.json") { Copy-Item "$folder/group-trial-result.json" launch-results/ }
    if (Test-Path "$folder/failed") { throw ((Get-Content "$folder/failed","$folder/observer.err" -Raw) -join ' ') }
    if (!(Test-Path "$folder/finished")) { throw "Limited controller timed out; task result: $((Get-ScheduledTaskInfo $task).LastTaskResult)" }
    $r=Get-Content "$folder/group-trial-result.json" -Raw | ConvertFrom-Json
    foreach ($mode in 'original','plain','appid','job','both') {
        $test=@($r.runs | Where-Object run -eq $mode)
        if (!$test.Count -and $r.verdict -eq 'repeatable-launch-effect') {continue}
        if (!$test.Count -or $test[0].status -eq 'inconclusive' -or $test[0].samples[-1].mainElevated -ne 'no') { throw "Unverified $mode or wrong privilege level" }
    }
    $summary=($r.runs | ForEach-Object {"$($_.run):$($_.status)"}) -join '; '
    "result=$summary" >> $env:GITHUB_OUTPUT
} finally { Unregister-ScheduledTask -TaskName $task -Confirm:$false }
