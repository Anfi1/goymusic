# Run against a fresh, disposable NSIS installation, not a user's installation.
#Requires -Version 7.0
param([Parameter(Mandatory)][string]$InstallDir)
$ErrorActionPreference = 'Stop'
$InstallDir = (Get-Item -LiteralPath $InstallDir).FullName.TrimEnd('\')
$prefix = "$InstallDir\"
$tempRoots = @([IO.Path]::GetTempPath(), $env:RUNNER_TEMP) | Where-Object { $_ }
if (!($tempRoots | Where-Object { $InstallDir.StartsWith(($_.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) })) {
    throw 'Refusing to instrument an installation outside TEMP/RUNNER_TEMP'
}
$exe = Join-Path $InstallDir 'GoyMusic.exe'
$python = Join-Path $InstallDir 'resources\python\bin\python.exe'
$api = Join-Path $InstallDir 'resources\python\api.py'
foreach ($name in 'browser.json', 'window-config.json', 'oauth.json', 'yandex.json') {
    if (Test-Path -LiteralPath "$InstallDir\resources\$name") { throw 'Expected a clean candidate with no legacy user data' }
}

function Get-ProcessTable {
    Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate, ExecutablePath
}
filter Select-CandidateProcess {
    if ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $_ }
}
function Start-CandidateProcess($file, [string[]]$arguments, [hashtable]$extraEnv = @{}) {
    $info = [Diagnostics.ProcessStartInfo]::new($file)
    $info.WorkingDirectory = $InstallDir
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    foreach ($arg in $arguments) { $info.ArgumentList.Add($arg) }
    foreach ($key in $extraEnv.Keys) { $info.Environment[$key] = $extraEnv[$key] }
    [Diagnostics.Process]::Start($info)
}
function Assert-Controls {
    foreach ($p in $controls) {
        if ($p.HasExited) { throw "Unrelated process $($p.Id) exited ($($p.ExitCode))" }
    }
}
function Test-Exit($mode) {
    $caseDir = (New-Item -ItemType Directory -Path "$work\$mode").FullName
    $profile = (New-Item -ItemType Directory -Path "$caseDir\profile").FullName
    $fixture = Join-Path $caseDir 'owned-node.cjs'
    Copy-Item -LiteralPath "$PSScriptRoot\owned-node.cjs" -Destination $fixture
    $app = Start-CandidateProcess $exe @("--user-data-dir=$profile") @{
        GOY_OWNED_NODE = $node; GOY_OWNED_PROBE = $fixture; GOY_OWNED_PROFILE = $profile
    }
    try {
        $clock = [Diagnostics.Stopwatch]::StartNew()
        do {
            if ($app.HasExited) { throw "$mode primary $($app.Id) exited during startup ($($app.ExitCode))" }
            $app.Refresh()
            if ($app.MainWindowHandle -ne 0 -and (Test-Path -LiteralPath "$fixture.ready")) { break }
            if ($clock.Elapsed.TotalSeconds -gt 60) { throw "$mode timed out waiting for the window and live Node leaf" }
            Start-Sleep -Milliseconds 100
        } while ($true)

        $leafId = [int][IO.File]::ReadAllText("$fixture.ready")
        $table = @(Get-ProcessTable)
        $rows = @($table | Select-CandidateProcess | Where-Object { $controls.Id -notcontains $_.ProcessId })
        $leaf = @($rows | Where-Object { $_.ProcessId -eq $leafId -and $_.ExecutablePath -eq $node })
        $branch = @($rows | Where-Object { $_.ProcessId -eq $leaf.ParentProcessId -and $_.ExecutablePath -eq $node })
        $backend = @($rows | Where-Object { $_.ProcessId -eq $branch.ParentProcessId -and $_.ExecutablePath -eq $python -and $_.ParentProcessId -eq $app.Id })
        $electron = @($rows | Where-Object { $_.ParentProcessId -eq $app.Id -and $_.ExecutablePath -eq $exe })
        if ($leaf.Count -ne 1 -or $branch.Count -ne 1 -or $backend.Count -ne 1 -or !$electron.Count) {
            throw "$mode did not find a live Electron helper and the exact primary -> packaged Python -> packaged Node -> Node leaf chain: $($rows | Out-String)"
        }
        # Keep the identity of every observed descendant, even a sandboxed process
        # for which Windows withholds the image path. A reused PID is not a survivor.
        $rootRow = $rows | Where-Object ProcessId -eq $app.Id
        $birth = @{}
        $birth[$rootRow.ProcessId] = $rootRow.CreationDate
        do {
            $count = $birth.Count
            foreach ($row in $table) {
                if (!$birth.ContainsKey($row.ProcessId) -and $birth.ContainsKey($row.ParentProcessId) -and
                    $row.CreationDate -ge $birth[$row.ParentProcessId]) { $birth[$row.ProcessId] = $row.CreationDate }
            }
        } while ($count -ne $birth.Count)
        Assert-Controls
        Write-Host "$mode before: root=$($app.Id) python=$($backend.ProcessId) node=$($branch.ProcessId) leaf=$leafId electron=$($electron.ProcessId -join ',') unrelated=$($controls.Id -join ',')"
        if ($mode -eq 'forced') {
            $app.Kill() # Terminate only this process; never tree-kill, even if the test fails.
        } elseif (!$app.CloseMainWindow()) { throw 'WM_CLOSE failed' }
        if (!$app.WaitForExit(15000)) { throw "$mode primary did not exit" }
        if ($mode -eq 'normal' -and $app.ExitCode -ne 0) { throw "Unclean normal exit: $($app.ExitCode)" }

        # Sweep the whole isolated install, not just previous PIDs or current ancestry:
        # this also finds late-spawned helpers whose intermediate parent has vanished.
        $clock.Restart()
        do {
            $table = @(Get-ProcessTable)
            $left = @($table | Where-Object { $birth.ContainsKey($_.ProcessId) -and $birth[$_.ProcessId] -eq $_.CreationDate })
            if (!$left.Count) {
                $left = @($table | Select-CandidateProcess | Where-Object { $controls.Id -notcontains $_.ProcessId })
            }
            if (!$left.Count) { break }
            if ($clock.Elapsed.TotalSeconds -gt 15) { throw "$mode left installed processes alive: $($left | Out-String)" }
            Start-Sleep -Milliseconds 100
        } while ($true)
        Assert-Controls
        Write-Host "$mode after: no installed processes except both unrelated controls"
    } finally {
        # On a failing build, only our test nodes observe this teardown signal.
        Remove-Item -LiteralPath $fixture
        if (!$app.HasExited) { $app.Kill(); $null = $app.WaitForExit(15000) }
        $app.Dispose()
    }
}

if (Get-ProcessTable | Select-CandidateProcess) { throw 'Expected a stopped, isolated installed candidate' }
$nodePath = & $python -c "import os, nodejs_wheel.executable as n; print(os.path.join(n.ROOT_DIR, 'node.exe'))"
if ($LASTEXITCODE) { throw 'Packaged Python cannot locate the packaged Node runtime' }
$node = (Get-Item -LiteralPath $nodePath).FullName
if (!$node.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Expected packaged Node; found $node" }

$work = (New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) "goy-owned-$([guid]::NewGuid())")).FullName
$backup = Join-Path $work 'api.original'
$controls = @()
try {
    # Insert only a test launch immediately before the real entrypoint. The original
    # backend, including its production ownership setup, still runs in the installed app.
    $source = [IO.File]::ReadAllText($api)
    $anchor = [regex]'(?m)^if __name__ == "__main__":\r?$'
    if ($anchor.Matches($source).Count -ne 1) { throw 'Unexpected installed api.py entrypoint' }
    $probe = @'
if __name__ == "__main__" and "GOY_OWNED_PROBE" in os.environ:
    import subprocess
    if not os.path.samefile(os.environ["GOYMUSIC_USER_DATA"], os.environ["GOY_OWNED_PROFILE"]):
        raise RuntimeError("Expected an isolated test profile")
    subprocess.Popen([os.environ["GOY_OWNED_NODE"], os.environ["GOY_OWNED_PROBE"], "branch"],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     creationflags=subprocess.CREATE_NO_WINDOW)
'@
    Copy-Item -LiteralPath $api -Destination $backup
    [IO.File]::WriteAllText($api, $source.Insert($anchor.Match($source).Index, $probe + "`n`n"))
    # These controls use the exact same installed binaries, but are our children, not Electron's.
    $controls += Start-CandidateProcess $python @('-c', 'import time; time.sleep(600)')
    $controls += Start-CandidateProcess $node @('-e', 'setTimeout(() => {}, 600000)')
    Test-Exit 'forced'
    Test-Exit 'normal'
} finally {
    try {
        foreach ($p in $controls) {
            if (!$p.HasExited) { $p.Kill(); $null = $p.WaitForExit(15000) }
            $p.Dispose()
        }
    } finally {
        if (Test-Path -LiteralPath $backup) { Copy-Item -LiteralPath $backup -Destination $api -Force }
        Remove-Item -LiteralPath $work -Recurse -Force
    }
}
