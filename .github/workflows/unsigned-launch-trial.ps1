$ErrorActionPreference='Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or (Get-CimInstance Win32_OperatingSystem).ProductType -ne 1) { throw 'Disposable Windows client required' }
$null=New-Item -ItemType Directory launch-results
$dir="$env:ProgramFiles\GoyMusic unsigned trial"; $exe="$dir\GoyMusic.exe"
$setup="$env:RUNNER_TEMP\GoyMusic-Setup-7.1.15.exe"
Invoke-WebRequest 'https://github.com/Anfi1/goymusic/releases/download/v7.1.15/GoyMusic-Setup-7.1.15.exe' -OutFile $setup
if ([Convert]::ToBase64String([Convert]::FromHexString((Get-FileHash $setup -Algorithm SHA512).Hash)) -cne '/uqYTibZ3lAr4dUWKgk3Q6gGJf4MT70OiEjKjXmbKgaAI1eeLhexFD0fhi0Int33wyL9tsT6To/clEp+OqlXTw==') { throw 'Unexpected official EXE' }
$p=Start-Process $setup -ArgumentList '/S','/allusers',"/D=$dir" -Wait -PassThru; if ($p.ExitCode) { throw 'Setup failed' }
Start-Process "$env:WINDIR\System32\Taskmgr.exe"
. "$PSScriptRoot/memory-sort.ps1"
Start-Sleep -Seconds 4
$t=Get-Process Taskmgr | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
if (!$t -or !(Select-MemoryDescending $t.MainWindowHandle)) { throw 'Descending Memory check failed' }
$pipe='goy-group-'+[guid]::NewGuid().ToString('N')
$folder=(New-Item -ItemType Directory "$env:PUBLIC\Documents\$pipe").FullName
$current=[Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls $folder /inheritance:r /grant:r ('{0}:(OI)(CI)F' -f $current) 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE) {throw 'Failed to restrict test work directory'}
$name='GoyTrial'+[guid]::NewGuid().ToString('N').Substring(0,8)
$pw=ConvertTo-SecureString ('aA1!'+[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))) -AsPlainText -Force
$account=New-LocalUser -Name $name -Password $pw
if ($account.SID.Value -notin (Get-LocalGroupMember -SID 'S-1-5-32-545').SID.Value) {
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $account
}
$credential=[Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$name",$pw)
& icacls $folder /grant ('*{0}:(OI)(CI)M' -f $account.SID.Value) | Out-Null
if ($LASTEXITCODE) { throw 'Failed to grant private test folder access' }
Copy-Item ./tools/group-trial*.ps1 $folder
$ps="$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$env:PSModulePath="$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules;"+$env:PSModulePath
# The stock runner account has a full token even for a LeastPrivilege scheduled task.
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
$errLog=Join-Path $env:RUNNER_TEMP "$pipe-observer.err"
try {
    $testProcess=Start-Process $ps -Credential $credential -LoadUserProfile -WorkingDirectory $folder -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$folder/controller.ps1`"" -PassThru
    Start-Sleep -Seconds 29
    $obs=Start-Process $ps -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$PSScriptRoot/../../tools/group-trial-observe.ps1`" -PipeName $pipe" -PassThru -RedirectStandardError $errLog
    $obs.Id | Set-Content "$folder/observer.pid"
    $deadline=(Get-Date).AddMinutes(10)
    while ((Get-Date) -lt $deadline -and !(Test-Path "$folder/finished") -and !(Test-Path "$folder/failed")) {Start-Sleep -Seconds 3}
    if (Test-Path "$folder/group-trial-result.json") { Copy-Item "$folder/group-trial-result.json" launch-results/ }
    if (Test-Path "$folder/failed") { throw ((Get-Content "$folder/failed",$errLog -Raw) -join ' ') }
    if (!(Test-Path "$folder/finished")) { throw "Standard-user controller timed out; exited=$($testProcess.HasExited)" }
    $r=Get-Content "$folder/group-trial-result.json" -Raw | ConvertFrom-Json
    foreach ($mode in 'original','plain','appid','job','both') {
        $test=@($r.runs | Where-Object run -eq $mode)
        if (!$test.Count -and $r.verdict -eq 'repeatable-launch-effect') {continue}
        if (!$test.Count -or $test[0].status -eq 'inconclusive' -or $test[0].samples[-1].mainElevated -ne 'no') { throw "Unverified $mode or wrong privilege level" }
    }
    $summary=($r.runs | ForEach-Object {"$($_.run):$($_.status)"}) -join '; '
    "result=$summary" >> $env:GITHUB_OUTPUT
} finally { Remove-LocalUser -SID $account.SID; $pw.Dispose() }
