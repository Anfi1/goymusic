# Run only on a disposable GitHub-hosted windows-11-arm worker, from the repo root.
[CmdletBinding()]
param([string]$InputDir = 'msix-out', [string]$EvidenceDir = 'msix-evidence')
$ErrorActionPreference = 'Stop'
$EvidenceDir = (New-Item -ItemType Directory -Force $EvidenceDir).FullName
$report = [ordered]@{
    python = 'inconclusive'; controlledNode = 'inconclusive'; musicNode = 'inconclusive'
    backend = 'no pong observed'; playback = 'not exercised: fresh profile, no login'
    mode = 'real backend with a controlled bundled Node child, not a stream resolver'
    reasons = [ordered]@{musicNode = 'No authenticated music workflow or resolver was exercised.'}
}
function Save-Json($file, $value) {
    ConvertTo-Json -InputObject $value -Depth 8 | Set-Content -Encoding utf8 (Join-Path $EvidenceDir $file)
}
function Note($message) {
    "$(Get-Date -AsUTC -Format o) $message" | Add-Content (Join-Path $EvidenceDir 'probe.log')
    Write-Host $message
}
function Get-Inventory {
    # Never include process arguments, env, profile data, or auth material in the artifact.
    @(Get-CimInstance Win32_Process -Filter "SessionId=$sessionId AND (Name='python.exe' OR Name='pythonw.exe' OR Name='node.exe' OR Name='GoyMusic MSIX Lab.exe')" |
        Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate)
}
function Is-InPackage($process) {
    $process.ExecutablePath -and $process.ExecutablePath.StartsWith($pkg.InstallLocation + '\', [StringComparison]::OrdinalIgnoreCase)
}
$targets = @()
$sessionId = (Get-Process -Id $PID).SessionId
Save-Json 'result.json' $report
try {
    $os = Get-CimInstance Win32_OperatingSystem
    $report.hostInfo = @{caption=$os.Caption; build=$os.BuildNumber; productType=$os.ProductType; session=$sessionId;
        arch=[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString(); interactive=[Environment]::UserInteractive}
    if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
        $report.hostInfo.arch -ne 'Arm64' -or $os.ProductType -ne 1 -or [int]$os.BuildNumber -lt 22000) {
        throw 'Refusing trust/install: requires a disposable GitHub-hosted Windows 11 ARM64 client.'
    }
    $hostOk = $true
    . "$PSScriptRoot/task-manager.ps1"
    $file = (Get-Item (Join-Path $InputDir 'GoyMusic-Lab-x64.msix')).FullName
    $certPath = (Get-Item (Join-Path $InputDir 'GoyMusic-Lab.cer')).FullName
    $cert = [Security.Cryptography.X509Certificates.X509Certificate2]::new($certPath)
    if ($cert.Subject -cne 'CN=GoyMusic Grouping Lab' -or $cert.Issuer -cne $cert.Subject -or $cert.HasPrivateKey) { throw 'Unexpected lab certificate' }
    $report.input = @{msixSHA256=(Get-FileHash $file).Hash; thumbprint=$cert.Thumbprint}
    Import-Module Appx -UseWindowsPowerShell -WarningAction SilentlyContinue
    if (Get-AppxPackage -Name GoyMusic.GroupingLab) { throw 'Expected a clean runner with no lab installation' }
    $store = [Security.Cryptography.X509Certificates.X509Store]::new('TrustedPeople','LocalMachine')
    $store.Open('ReadWrite')
    if (!$store.Certificates.Find('FindByThumbprint',$cert.Thumbprint,$false).Count) { $store.Add($cert); $addedTrust = $true }
    Add-AppxPackage -Path $file
    $installed = $true
    $pkg = Get-AppxPackage -Name GoyMusic.GroupingLab
    if ($pkg.Name -cne 'GoyMusic.GroupingLab' -or $pkg.Publisher -cne $cert.Subject -or $pkg.PackageFullName -notlike '*_x64__*') { throw 'Unexpected installed package identity' }
    $appId = "$($pkg.PackageFamilyName)!Player"
    $report.package = @{fullName=$pkg.PackageFullName; family=$pkg.PackageFamilyName; location=$pkg.InstallLocation; appId=$appId}
    $state = Join-Path $env:LOCALAPPDATA "Packages/$($pkg.PackageFamilyName)/LocalState"
    $null = New-Item -ItemType Directory -Force $state
    $null = New-Item -ItemType File (Join-Path $state 'grouping-probe.request')
    Start-Process "$env:WINDIR/explorer.exe" -ArgumentList "shell:AppsFolder\$appId"
    $deadline = (Get-Date).AddSeconds(60)
    do {
        Start-Sleep -Milliseconds 500
        if ((Test-Path "$state/app.log") -and (Select-String -Quiet -SimpleMatch 'MSIX lab backend: pong' "$state/app.log")) {
            $report.backend = 'pong'; break
        }
    } while ((Get-Date) -lt $deadline)
    $fixture = if (Test-Path "$state/grouping-probe.json") { Get-Content "$state/grouping-probe.json" -Raw | ConvertFrom-Json }
    $before = @(Get-Inventory)
    Save-Json 'processes-before.json' $before
    $roots = @($before | Where-Object { $_.Name -eq 'GoyMusic MSIX Lab.exe' -and (Is-InPackage $_) })
    $backend = @($before | Where-Object { $_.Name -eq 'python.exe' -and (Is-InPackage $_) -and $_.ParentProcessId -in $roots.ProcessId })
    if ($backend.Count -eq 1) { $targets += @{key='python'; record=$backend[0]} }
    if ($backend.Count -eq 1 -and $fixture.kind -ceq 'controlled-bundled-node' -and $fixture.pythonPid -eq $backend[0].ProcessId) {
        $node = @($before | Where-Object { $_.Name -eq 'node.exe' -and (Is-InPackage $_) -and $_.ParentProcessId -eq $fixture.pythonPid -and $_.ProcessId -eq $fixture.nodePid })
        if ($node.Count -eq 1) { $targets += @{key='controlledNode'; record=$node[0]} }
    }
    $report.attributed = @($targets | ForEach-Object { @{role=$_.key; pid=$_.record.ProcessId} })
    foreach ($key in 'python','controlledNode') {
        $report.reasons[$key] = if ($key -in $targets.key) { 'No conclusive visible row transition recorded.' } else { 'No verified live target PID in the installed package.' }
    }
    Note "Backend: $($report.backend); attributed candidates: $($targets.Count)."
    Save-Json 'result.json' $report
} catch { $report.setupError = $_.Exception.Message; Note $report.setupError }
try {
    if ($hostOk) {
        Open-DesktopProbe
        Save-Screen 'desktop-after-activation'
        Get-TaskManagerProof
    }
} catch { $report.uiError = $_.Exception.Message; Note $report.uiError }
finally {
    if ($hostOk) {
        try { Save-Screen 'desktop-final' } catch { Note "Final desktop capture failed: $_" }
        try {
            $after = @(Get-Inventory)
            Save-Json 'processes-after.json' $after
            foreach ($t in $targets) {
                $live = @($after | Where-Object { $_.ProcessId -eq $t.record.ProcessId -and $_.CreationDate -eq $t.record.CreationDate -and $_.ExecutablePath -eq $t.record.ExecutablePath })
                if (!$live.Count) { $report[$t.key] = 'inconclusive'; $report.reasons[$t.key] = 'Target did not survive the observation.' }
            }
        } catch { $report.python = $report.controlledNode = 'inconclusive'; Note "Final process correlation failed: $_" }
    }
    if ($installed) { try { Get-AppxPackage -Name GoyMusic.GroupingLab | Remove-AppxPackage } catch { Note "Uninstall failed: $_" } }
    if ($addedTrust) { try { $store.Remove($cert) } catch { Note "Removing lab trust failed: $_" } }
    if ($store) { $store.Close() }
    Save-Json 'result.json' $report
    $label = @{yes='grouped'; no='not grouped'; inconclusive='inconclusive'}
    $verdict = "Python $($label[$report.python]); controlled Node $($label[$report.controlledNode]); music Node $($label[$report.musicNode]); backend $($report.backend)"
    if ($env:GITHUB_OUTPUT) { "verdict=$verdict" >> $env:GITHUB_OUTPUT }
    Note $verdict
}
if ($report.setupError) { throw $report.setupError }
