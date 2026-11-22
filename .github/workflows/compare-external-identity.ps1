$ErrorActionPreference='Stop'
$os=Get-CimInstance Win32_OperatingSystem
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $os.ProductType -ne 1 -or [int]$os.BuildNumber -lt 22000) { throw 'Disposable Windows 11 runner required' }
$null=New-Item -ItemType Directory observations
. "$PSScriptRoot/memory-sort.ps1"
. "$PSScriptRoot/read-identity-groups.ps1"
$dir="$env:RUNNER_TEMP\GoyMusic NSIS identity test"
$exe="$dir\GoyMusic.exe"; $pyFolder="$dir\resources\python"; $api="$pyFolder\api.py"; $ready="$pyFolder\group-ready.json"
$setup="$env:RUNNER_TEMP\GoyMusic-Setup-7.1.16.exe"
Invoke-WebRequest 'https://github.com/Anfi1/goymusic/releases/download/v7.1.16/GoyMusic-Setup-7.1.16.exe' -OutFile $setup
if ([Convert]::ToBase64String([Convert]::FromHexString((Get-FileHash $setup -Algorithm SHA512).Hash)) -cne 'RbArMzXANd0Aa34in6uzza4HNzngw0mdLEj7fXkluNbLmwaZxLAtw5KzIczrI10CI0MTCECIOX2v/dYOPrBegA==') { throw 'Unexpected NSIS installer' }
$p=Start-Process $setup -ArgumentList '/S',"/D=$dir" -PassThru -Wait
if ($p.ExitCode) { throw 'NSIS install failed' }
$link=@(foreach ($folder in 'Programs','CommonPrograms') {
    Get-ChildItem ([Environment]::GetFolderPath($folder)) -Filter 'GoyMusic.lnk' -Recurse | Where-Object { (New-Object -ComObject WScript.Shell).CreateShortcut($_.FullName).TargetPath -eq $exe }
})[0]
if (!$link) { throw 'No matching original Start menu shortcut' }
Copy-Item './identity-kit/lab-app-id.node',"$PSScriptRoot/lab-group-probe.py" -Destination $pyFolder
$source=[IO.File]::ReadAllText($api); $anchor=[regex]'(?m)^if __name__ == "__main__":\r?$'
if ($anchor.Matches($source).Count -ne 1) { throw 'Unexpected packaged api.py' }
$hook="if __name__ == '__main__':`n    import runpy`n    _group_probe = runpy.run_path(os.path.join(os.path.dirname(__file__), 'lab-group-probe.py'))`n"
[IO.File]::WriteAllText($api,$source.Insert($anchor.Match($source).Index,$hook))
Start-Process "$env:WINDIR\System32\Taskmgr.exe"
for ($i=0;$i -lt 30;$i++) { $tm=Get-Process Taskmgr -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if ($tm) {break}; Start-Sleep -Milliseconds 500 }
if (!$tm -or !(Select-MemoryDescending $tm.MainWindowHandle)) { throw 'Cannot verify descending memory sort' }
function Measure-Mode($mode) {
    Set-Content "$pyFolder/group-mode.txt" $mode -Encoding ascii
    if (Test-Path $ready) { Remove-Item $ready }
    Start-Process $link.FullName
    for ($i=0;$i -lt 90;$i++) { if (Test-Path $ready) { break }; Start-Sleep -Seconds 1 }
    if (!(Test-Path $ready)) { throw "Backend did not start in mode $mode" }
    $observed=Get-Content $ready -Raw | ConvertFrom-Json
    $main=Get-Process -Id $observed.parent
    if ($main.Path -ne $exe) { throw "Unexpected parent in $mode" }
    Start-Sleep -Seconds 30
    try { Measure-IdentityGroups $dir $mode $main.Id $observed.python $observed.node }
    finally {
        $main.Refresh()
        if (!$main.HasExited -and (!$main.CloseMainWindow() -or !$main.WaitForExit(10000))) {
            # Only this disposable fixture: teardown is not a lifecycle measurement.
            if (!$main.HasExited) { $main.Kill($true); $main.WaitForExit() }
        }
        for ($i=0;$i -lt 40;$i++) {
            $left=@(Get-CimInstance Win32_Process -Filter "Name='GoyMusic.exe' OR Name='python.exe' OR Name='node.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir+'\',[StringComparison]::OrdinalIgnoreCase) })
            if (!$left.Count) {break}
            if ($i -eq 24) { foreach ($p in $left) { Stop-Process -Id $p.ProcessId -ErrorAction SilentlyContinue } }
            Start-Sleep -Milliseconds 250
        }
        if ($left.Count) { throw "Test directory still in use after $mode" }
    }
}
$baseline=Measure-Mode 'stock'; $appid=Measure-Mode 'app-id'
$certificate=Get-PfxCertificate -FilePath './identity-kit/lab.cer'
if ($certificate.Subject -ne 'CN=GoyMusic External Identity Test' -or $certificate.HasPrivateKey) { throw 'Unexpected lab certificate' }
$trusted=Import-Certificate -FilePath './identity-kit/lab.cer' -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople'
try {
    Import-Module Appx -UseWindowsPowerShell -WarningAction SilentlyContinue
    $package=(Resolve-Path './identity-kit/identity.msix').Path
    # The SDK verified both signatures before artifact upload. A leaf trusted for package
    # deployment need not be a root for Authenticode PE validation on this second runner.
    $sig=Get-AuthenticodeSignature -LiteralPath './identity-kit/GoyMusic.exe'
    if ($sig.SignerCertificate.Thumbprint -ne $certificate.Thumbprint -or $sig.Status -eq 'HashMismatch') { throw 'Wrong external EXE signature' }
    Copy-Item './identity-kit/GoyMusic.exe' $exe -Force
    Add-AppxPackage -Path $package -ExternalLocation $dir
    $pkg=Get-AppxPackage -Name GoyMusic.ExternalIdentityTest
    if (!$pkg -or $pkg.Publisher -ne $certificate.Subject) { throw 'Missing registered external identity' }
    $sparse=Measure-Mode 'external-identity'
    Copy-Item './identity-kit/python.exe' "$pyFolder/bin/python.exe" -Force
    Copy-Item './identity-kit/node.exe' "$pyFolder/bin/Lib/site-packages/nodejs_wheel/node.exe" -Force
    $all=Measure-Mode 'external-all'
    $summary="Stock: $baseline | AppID: $appid | external main: $sparse | external all: $all"
    Write-Host $summary; "groups=$summary" >> $env:GITHUB_OUTPUT
} finally {
    Get-AppxPackage -Name GoyMusic.ExternalIdentityTest | Remove-AppxPackage
    Remove-Item "Cert:\LocalMachine\TrustedPeople\$($trusted.Thumbprint)"
}
