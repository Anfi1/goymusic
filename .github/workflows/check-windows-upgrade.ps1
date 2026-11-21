param([switch]$LocalFeed)
$ErrorActionPreference = 'Stop'
$source = if ($LocalFeed) { 'local' } else { 'GitHub' }
$dir = Join-Path $env:RUNNER_TEMP "GoyMusic-update-$source"
$installer = Join-Path $env:RUNNER_TEMP "GoyMusic-Setup-$env:PREVIOUS.exe"
$setup = Start-Process $installer -ArgumentList '/S', "/D=$dir" -Wait -PassThru
if ($setup.ExitCode) { throw "Previous installer exited with $($setup.ExitCode)" }
$exe = Join-Path $dir 'GoyMusic.exe'
function Read-ReleaseVersion {
    $info = (Get-Item $exe).VersionInfo
    "$($info.ProductMajorPart).$($info.ProductMinorPart).$($info.ProductBuildPart)"
}
if ((Read-ReleaseVersion) -ne $env:PREVIOUS) { throw 'Unexpected starting version' }
$feed = $null
try {
    if ($LocalFeed) {
        # Only change the previous installation's provider; preserve signature settings.
        # Its private download cache cannot satisfy the later public GitHub download.
        $path = Join-Path $dir 'resources/app-update.yml'
        $config = Get-Content $path -Raw
        if ($config -notmatch '(?m)^provider: github\r?$' -or $config -notmatch '(?m)^updaterCacheDirName: ') { throw 'Unexpected previous update configuration' }
        $config = $config -replace '(?m)^provider: github\r?$', "provider: generic`nurl: http://127.0.0.1:8765/"
        ($config -replace '(?m)^updaterCacheDirName: .*$', 'updaterCacheDirName: goymusic-ci-local-updater') | Set-Content $path
        $feed = Start-Process python -ArgumentList '-m','http.server','8765','--bind','127.0.0.1' -WorkingDirectory (Resolve-Path release) -PassThru
        $ready = $false
        for ($i = 0; $i -lt 30 -and !$ready; $i++) {
            if ($feed.HasExited) { throw "Local update feed exited $($feed.ExitCode)" }
            try { $ready = (Invoke-WebRequest http://127.0.0.1:8765/latest.yml -TimeoutSec 2).StatusCode -eq 200 }
            catch { Start-Sleep -Milliseconds 250 }
        }
        if (!$ready) { throw 'Local update feed did not serve latest.yml' }
    }
    $env:NODE_PATH = "$env:RUNNER_TEMP/update-driver/node_modules"
    $process = Start-Process $exe -ArgumentList '--devtools','--remote-debugging-port=9222' -PassThru
    node .github/workflows/check-installed-update.cjs
    if ($LASTEXITCODE) { throw 'In-app download or install action failed' }
    $deadline = (Get-Date).AddMinutes(3)
    do {
        $running = @(Get-Process GoyMusic -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe -and $_.MainWindowHandle -ne 0 -and $_.Id -ne $process.Id })
        if ($process.HasExited -and $running.Count -eq 1 -and (Read-ReleaseVersion) -eq $env:EXPECTED) { break }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)
    if (!$process.HasExited -or $running.Count -ne 1 -or (Read-ReleaseVersion) -ne $env:EXPECTED) { throw 'Update did not restart in the original directory' }
    & ./.github/workflows/check-windows-lifecycle.ps1 -InstallDir $dir -RelaunchedPid $running[0].Id
    Write-Output "Verified $source in-place upgrade: $env:PREVIOUS -> $env:EXPECTED ($exe)"
    $uninstaller = Get-ChildItem $dir -Filter 'Uninstall*.exe' | Select-Object -First 1
    $uninstall = Start-Process $uninstaller.FullName -ArgumentList '/S', "_?=$dir" -Wait -PassThru
    if ($uninstall.ExitCode) { throw 'Update smoke uninstall failed' }
} finally {
    if ($feed -and !$feed.HasExited) { $feed.Kill() }
}
