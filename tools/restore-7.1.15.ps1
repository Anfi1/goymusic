$ErrorActionPreference = 'Stop'
$setup = Join-Path $PSScriptRoot 'GoyMusic-Setup-7.1.15.exe'
$setupPin = '/uqYTibZ3lAr4dUWKgk3Q6gGJf4MT70OiEjKjXmbKgaAI1eeLhexFD0fhi0Int33wyL9tsT6To/clEp+OqlXTw=='
# NSIS uses UUIDv5(com.goymusic.app, electron-builder namespace) for both keys.
$guid = 'c79608bd-9fff-5d8f-95b3-82bedc48e731'
$payloads = @{
    '7.1.15' = '0809787d862e3f14bc62bf05366d19c7cab47554dab077da4501e536965d3fcb','b6a2c9231738800cc0cbca251087a05dfb8e6bb8b8ba42dc126e554f8bb39ff4'
    '7.1.16' = 'd3103c1cdc872ced73288828511a6b0382ca96fd1766d5c39f468a6f2dfe5159','692e77e326cc7db73b6d6c788625e5990c6e72525f57c560c87fa25a22a68f04'
}

function Get-PayloadHash($path) {
    $file = [IO.File]::OpenRead($path)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($hash.ComputeHash($file)).Replace('-', '') }
    finally { $hash.Dispose(); $file.Dispose() }
}

function Get-Release {
    $info = (Get-Item -LiteralPath $exe).VersionInfo
    $version = $info.ProductVersion -replace '^(7\.1\.(?:15|16))\.0$', '$1'
    if ($info.ProductName -ne 'GoyMusic' -or !$payloads.ContainsKey([string]$version)) {
        throw "Unsupported product or version at $exe ($($info.ProductVersion)); expected official 7.1.15 or 7.1.16."
    }
    if ((Get-PayloadHash $exe) -ne $payloads[$version][0] -or
        (Get-PayloadHash (Join-Path $dir 'resources\app.asar')) -ne $payloads[$version][1]) {
        throw "The installed EXE or app.asar differs from official $version at $dir. Restore stopped."
    }
    $version
}

function Assert-Shortcut($link) {
    if (!(Test-Path -LiteralPath $link -PathType Leaf)) { throw "Missing Start menu shortcut: $link" }
    $s = $shell.CreateShortcut($link)
    if ($s.TargetPath -ne $exe -or $s.Arguments) { throw "Conflicting Start menu shortcut: $link -> $($s.TargetPath) $($s.Arguments)" }
}

function Assert-NoUpdate {
    $mutex = $null
    if ([Threading.Mutex]::TryOpenExisting($guid, [ref]$mutex)) {
        $mutex.Dispose()
        throw 'GoyMusic Setup is already open. Let it finish before restoring.'
    }
    if ((Test-Path -LiteralPath (Join-Path $env:TEMP 'com.goymusic.app.update-lock')) -or
        (Get-Process -Name 'GoyMusic-Setup-*','Uninstall GoyMusic' -ErrorAction SilentlyContinue)) {
        throw 'Another GoyMusic installation or update is in progress. Let it finish and retry.'
    }
    $pending = Join-Path $env:LOCALAPPDATA 'goymusic-updater\pending'
    if (Test-Path -LiteralPath $pending) {
        foreach ($f in (Get-ChildItem -LiteralPath $pending -File -Force)) {
            # A completed installer for the already installed version can remain after a successful update.
            if ($f.Name -like 'temp-*' -or ($f.Extension -eq '.exe' -and $f.Name -ne "GoyMusic-Setup-$version.exe")) {
                throw 'A GoyMusic update is downloading or staged. Finish the update normally before restoring.'
            }
        }
    }
}

try {
    if (!(Test-Path -LiteralPath $setup -PathType Leaf)) { throw "Place the original GoyMusic-Setup-7.1.15.exe next to this script: $PSScriptRoot" }
    # Keep the verified file open read-only and deny replacement through launch.
    $stream = [IO.File]::OpenRead($setup)
    $hash = [Security.Cryptography.SHA512]::Create()
    try { $actual = [Convert]::ToBase64String($hash.ComputeHash($stream)) }
    finally { $hash.Dispose() }
    if ($actual -cne $setupPin) { throw 'Wrong installer SHA-512. Obtain the original v7.1.15 installer from Anfi1/goymusic Releases.' }

    $dir = $null
    foreach ($hive in 'HKCU:', 'HKLM:') {
        foreach ($software in 'Software', 'Software\WOW6432Node') {
            $key = "$hive\$software\$guid"
            $arp = "$hive\$software\Microsoft\Windows\CurrentVersion\Uninstall\$guid"
            if (!(Test-Path -LiteralPath $key) -and !(Test-Path -LiteralPath $arp)) { continue }
            $location = (Get-ItemProperty -LiteralPath $key -Name InstallLocation).InstallLocation
            if ($location -notmatch '^[A-Z]:\\' -or $location.Contains("'")) { throw "Unsupported NSIS installation path: $location" }
            $candidate = (Get-Item -LiteralPath $location).FullName.TrimEnd('\')
            $scope = if ($hive -eq 'HKCU:') { '/currentuser' } else { '/allusers' }
            $registration = Get-ItemProperty -LiteralPath $arp
            if ($registration.DisplayName -ne 'GoyMusic' -or $registration.UninstallString -ne ('"{0}\Uninstall GoyMusic.exe" {1}' -f $candidate,$scope)) {
                throw "Conflicting GoyMusic installation records in $arp. Restore stopped."
            }
            if ($dir -and ($dir -ne $candidate -or $mode -ne $scope -or $registeredVersion -ne $registration.DisplayVersion)) {
                throw "Conflicting GoyMusic registrations: $dir and $candidate. Restore stopped."
            }
            $dir = $candidate; $mode = $scope; $registeredVersion = $registration.DisplayVersion
        }
    }
    if (!$dir) { throw 'No official GoyMusic NSIS installation registered for this Windows account.' }
    $exe = Join-Path $dir 'GoyMusic.exe'
    if ($PSScriptRoot.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase)) { throw "Extract the restore kit outside the install directory ($dir) and retry." }
    $profileDir = Join-Path $env:APPDATA 'GoyMusic'
    if ($profileDir -eq $dir -or $profileDir.StartsWith("$dir\", [StringComparison]::OrdinalIgnoreCase)) { throw "The player profile is inside the installation directory ($dir); refusing to overwrite it." }
    $shell = New-Object -ComObject WScript.Shell
    $links = @(foreach ($folder in 'Programs', 'CommonPrograms') {
        $root = [Environment]::GetFolderPath($folder)
        if (Test-Path -LiteralPath $root) { Get-ChildItem -LiteralPath $root -Filter 'GoyMusic.lnk' -File -Recurse }
    })
    if (!$links.Count) { throw 'No installed GoyMusic Start menu shortcut. Repair the official shortcut before restoring.' }
    foreach ($link in $links) { Assert-Shortcut $link.FullName }
    $launch = $links[0].FullName
    $version = Get-Release
    if ($version -ne $registeredVersion) { throw "Installed and registered versions disagree: $version / $registeredVersion." }
    Assert-NoUpdate

    $players = @(Get-Process -Name GoyMusic -ErrorAction SilentlyContinue)
    foreach ($p in $players) {
        if ($p.Path -ne $exe -or $p.SessionId -ne (Get-Process -Id $PID).SessionId) { throw 'Another or inaccessible copy of GoyMusic is running. Close it normally and retry.' }
    }
    foreach ($p in $players) {
        if ($p.MainWindowHandle -ne 0 -and !$p.CloseMainWindow()) { throw 'The player did not accept WM_CLOSE. Close GoyMusic normally and retry.' }
    }
    # NSIS may terminate processes with an image path starting with $dir. Never hand it a live helper.
    $until = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $busy = @(Get-CimInstance Win32_Process -Property Name,ExecutablePath | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir,[StringComparison]::OrdinalIgnoreCase) })
        if (!$busy.Count) { break }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $until)
    if ($busy.Count) { throw "Close the remaining process(es) normally before restoring: $($busy.Name -join ', ')." }
    Assert-NoUpdate

    Write-Host "Restoring official GoyMusic $version -> 7.1.15 in $dir"
    # NSIS consumes the entire unquoted remainder after /D=, including spaces.
    $installer = Start-Process -FilePath $setup -ArgumentList "/S $mode /D=$dir" -PassThru -Wait
    if ($installer.ExitCode -ne 0) { throw "GoyMusic Setup exited with code $($installer.ExitCode). Check installer permissions and retry." }
    if ((Get-Release) -ne '7.1.15') { throw "Setup did not restore 7.1.15 at $exe. The player has not been launched." }
    Assert-Shortcut $launch
    Start-Process -FilePath $launch
    $until = [DateTime]::UtcNow.AddSeconds(60)
    do {
        if (Get-Process -Name GoyMusic -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe -and $_.MainWindowHandle -ne 0 }) {
            Write-Host 'Restored and launched official GoyMusic 7.1.15.'
            exit 0
        }
        Start-Sleep -Milliseconds 400
    } while ([DateTime]::UtcNow -lt $until)
    throw "Restored 7.1.15 but no player window appeared. Open the installed Start menu shortcut: $launch"
} catch {
    [Console]::Error.WriteLine("Restore failed: $($_.Exception.Message)")
    exit 1
} finally {
    if ($stream) { $stream.Dispose() }
}
