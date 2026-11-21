param([Parameter(Mandatory)][string]$InstallDir)
$ErrorActionPreference = 'Stop'
$exe = (Get-Item -LiteralPath (Join-Path $InstallDir 'GoyMusic.exe')).FullName
# Packaged startup migrates these legacy files. Never move/read an existing user's settings.
foreach ($legacy in 'browser.json','window-config.json') {
    if (Test-Path -LiteralPath (Join-Path $InstallDir "resources\$legacy")) { throw 'Expected a clean NSIS installation without legacy profile files' }
}
$profile = Join-Path ([IO.Path]::GetTempPath()) "goy-ram-$([guid]::NewGuid())"
$null = New-Item -ItemType Directory -Path $profile
$app = $null
try {
    # Do not attach to a running user's renderer. Use a fresh profile and a loopback CDP port.
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { $port = $listener.LocalEndpoint.Port } finally { $listener.Stop() }
    $app = Start-Process -FilePath $exe -PassThru -ArgumentList @(
        '--devtools', '--remote-debugging-address=127.0.0.1', "--remote-debugging-port=$port", "`"--user-data-dir=$profile`""
    )
    $null = $app.Handle
    & node (Join-Path $PSScriptRoot 'ram-player.cjs') $app.Id $port $profile
    if ($LASTEXITCODE) { throw 'Installed player RAM measurement failed' }
    $app.Refresh()
    if (!$app.CloseMainWindow() -or !$app.WaitForExit(20000) -or $app.ExitCode -ne 0) { throw 'Player did not close cleanly' }

    $states = (Get-Content -LiteralPath 'ram-report.json' -Raw | ConvertFrom-Json).states
    $summary = "Idle: $($states.idle.medianMiB) MiB; playing: $($states.playing.medianMiB) MiB; minimized playing: $($states.minimized.medianMiB) MiB (tree private working set)"
    Write-Output $summary
    if ($env:GITHUB_OUTPUT) { Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "ram=$summary" -Encoding utf8 }
} finally {
    if ($app -and !$app.HasExited) { $app.Kill($true); $app.WaitForExit() }
    if ($app) { $app.Dispose() }
    Remove-Item -LiteralPath $profile -Recurse -Force
}
