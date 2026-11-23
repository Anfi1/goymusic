param([switch]$Hosted)
$ErrorActionPreference='Stop'
$exe=Join-Path $PSScriptRoot 'player\GoyMusic.exe'
if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Extract the whole archive before running the comparison.' }
if ($Hosted -and $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Hosted observations require a disposable runner.' }
if (!$Hosted -and ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Start this file normally, not as administrator.' }
if (Get-Process GoyMusic -ErrorAction SilentlyContinue | Where-Object Path -eq $exe) { throw 'Close the previous test window first.' }
$report=Join-Path $PSScriptRoot 'window-trial-result.json'
$records=@(); $labels='A','B','A2'; $os=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
trap {
    if ($Hosted) { Write-Host "::error::${label}: $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))" }
    break
}
Write-Host 'Open Task Manager > Processes. Keep your usual sorting. Three short runs; only the test player is closed.'
foreach ($label in $labels) {
    $launch=@{FilePath=$exe;WorkingDirectory=(Split-Path $exe);PassThru=$true}
    if ($label -eq 'B') { $launch.ArgumentList='--trial-process-id-only' }
    $p=Start-Process @launch
    try {
        Start-Sleep -Seconds 30
        $p.Refresh(); if ($p.HasExited -or $p.MainWindowHandle -eq [IntPtr]::Zero) { throw "No visible test player in $label" }
        $session=$p.SessionId
        $family=@(Get-CimInstance Win32_Process -Filter "Name='GoyMusic.exe' AND SessionId=$session" | Where-Object { $_.ExecutablePath -eq $exe })
        if ($family.Count -lt 2 -or $family.ProcessId -notcontains $p.Id -or !($family | Where-Object ParentProcessId -eq $p.Id)) { throw 'Electron process tree not available.' }
        Write-Host "${label}: test window PID $($p.Id), $($family.Count) GoyMusic.exe processes."
        try {
            $out=Join-Path $PSScriptRoot "snapshot-$label.json"
            & "$PSHOME/powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot/check-goymusic-group.ps1" -OutFile $out
            if ($LASTEXITCODE) { throw 'Cannot read Task Manager.' }
            $snapshot=Get-Content $out -Raw | ConvertFrom-Json
            $signatures=@()
            $observed=@(foreach ($s in $snapshot.samples) {
                if ($s.uiError) { throw $s.uiError }
                $root=@($s.processes | Where-Object { $_.pid -eq $p.Id -and $_.role -eq 'main' })
                if ($root.Count -ne 1 -or $root[0].install -eq 'unknown') { throw 'Unverified player root.' }
                $seen=@($s.processes | Where-Object { $_.install -eq $root[0].install })
                if ($seen.role -notcontains 'renderer' -or @($seen | Where-Object { !$_.taskManagerRows.Count -or ($_.pid -ne $p.Id -and $_.parent -ne $p.Id) }).Count) { throw 'Incomplete Task Manager process tree.' }
                $signatures+=@(($seen.pid -join ','))
                $groups=@(foreach ($r in $seen) { $entry=$r.taskManagerRows[0]; if ($entry.parentGoyMusicRow) {$entry.parentGoyMusicRow} else {$entry.row} })
                if (@($groups | Select-Object -Unique).Count -eq 1) {'grouped'} else {'split'}
            })
            if (@($signatures | Select-Object -Unique).Count -ne 1) { throw 'Process membership changed between samples.' }
            $state=if (@($observed | Select-Object -Unique).Count -eq 1) {$observed[0]} else {'unclear'}
        } catch {
            if ($Hosted) { throw }
            Write-Host 'Task Manager cannot be read at normal privilege. No elevation requested.'
            do { $answer=Read-Host 'In Processes: 1 = all test EXEs under one row, 2 = separate rows, 3 = unclear' } until ($answer -in '1','2','3')
            $state=@{'1'='grouped';'2'='split';'3'='unclear'}[$answer]
        }
        $records+=@([pscustomobject]@{mode=$label;pid=$p.Id;total=$family.Count;status=$state})
        $verdict=if ($records.Count -lt 3) {'incomplete'} elseif (($records.status -join ',') -eq 'split,grouped,split') {'process-only-grouped'} elseif (@($records.status | Select-Object -Unique).Count -eq 1 -and $state -ne 'unclear') {'no-difference'} else {'inconclusive'}
        [ordered]@{windowsBuild="$($os.CurrentBuild).$($os.UBR)";verdict=$verdict;runs=$records} | ConvertTo-Json -Depth 4 | Set-Content $report -Encoding UTF8
    } finally {
        if (!$p.HasExited) { $p.Refresh(); if (!$p.CloseMainWindow() -or !$p.WaitForExit(20000)) { throw 'Test player did not close normally; no process was killed.' } }
        $p.Dispose()
    }
    $deadline=[datetime]::UtcNow.AddSeconds(20)
    while (Get-Process GoyMusic -ErrorAction SilentlyContinue | Where-Object Path -eq $exe) {
        if ([datetime]::UtcNow -gt $deadline) { throw 'Test helpers did not exit, no second launch attempted.' }
        Start-Sleep -Milliseconds 250
    }
}
Write-Host "Result: $verdict. Report: $report"
