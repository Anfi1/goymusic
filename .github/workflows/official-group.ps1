$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or (Get-CimInstance Win32_OperatingSystem).ProductType -ne 1) { throw 'Requires a disposable Windows client runner' }
$null = New-Item -ItemType Directory observations
$dir = "$env:RUNNER_TEMP\GoyMusic official restore test"
$exe = "$dir\GoyMusic.exe"
$py = "$dir\resources\python\bin\python.exe"
$setup = "$env:RUNNER_TEMP\GoyMusic-Setup-7.1.15.exe"
Invoke-WebRequest 'https://github.com/Anfi1/goymusic/releases/download/v7.1.15/GoyMusic-Setup-7.1.15.exe' -OutFile $setup
if ([Convert]::ToBase64String([Convert]::FromHexString((Get-FileHash $setup -Algorithm SHA512).Hash)) -cne '/uqYTibZ3lAr4dUWKgk3Q6gGJf4MT70OiEjKjXmbKgaAI1eeLhexFD0fhi0Int33wyL9tsT6To/clEp+OqlXTw==') { throw 'Unexpected 7.1.15 installer' }
$p = Start-Process $setup -ArgumentList '/S',"/D=$dir" -PassThru -Wait
if ($p.ExitCode -ne 0) { throw 'NSIS installation failed' }
function Shortcut {
    $links = @(foreach ($folder in 'Programs','CommonPrograms') {
        Get-ChildItem ([Environment]::GetFolderPath($folder)) -Filter 'GoyMusic.lnk' -Recurse | Where-Object { (New-Object -ComObject WScript.Shell).CreateShortcut($_.FullName).TargetPath -eq $exe }
    })
    if (!$links.Count) { throw 'No installed shortcut' }
    $links[0].FullName
}
function MainWindow($version,$previous=0) {
    for ($i=0;$i -lt 90;$i++) {
        $p = @(Get-Process GoyMusic -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe -and $_.MainWindowHandle -ne 0 -and $_.Id -ne $previous })
        if ($p.Count -eq 1 -and (Get-Item $exe).VersionInfo.ProductVersion.StartsWith($version)) { return $p[0] }
        Start-Sleep -Seconds 1
    }
    throw "No player window for $version"
}
function Stop-Player($p) {
    if (!$p.CloseMainWindow() -or !$p.WaitForExit(15000)) { throw 'Expected normal player shutdown' }
    for ($i=0;$i -lt 20;$i++) {
        if (!(Get-Process GoyMusic -ErrorAction SilentlyContinue | Where-Object Path -eq $exe)) { return }
        Start-Sleep -Milliseconds 250
    }
    throw 'Installed helpers remain'
}
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
. "$PSScriptRoot/memory-sort.ps1"
function Snapshot($tag,$index) {
    $manager = Get-Process Taskmgr | Where-Object { $_.MainWindowHandle -ne 0 -and $_.SessionId -eq (Get-Process -Id $PID).SessionId } | Select-Object -First 1
    if (!$manager) { throw 'No Task Manager HWND' }
    $inventory = @(Get-CimInstance Win32_Process -Filter "Name='GoyMusic.exe' OR Name='python.exe'" | Where-Object { $_.ExecutablePath -in $exe,$py } | Select-Object ProcessId,ParentProcessId,Name)
    $cache = [Windows.Automation.CacheRequest]::new(); $cache.TreeScope = 'Subtree'; $cache.TreeFilter = [Windows.Automation.Automation]::RawViewCondition
    foreach ($k in 'Name','AutomationId','ControlType','IsOffscreen') { $prop="${k}Property"; $cache.Add([Windows.Automation.AutomationElement]::$prop) }
    $root=[Windows.Automation.AutomationElement]::FromHandle($manager.MainWindowHandle).GetUpdatedCache($cache)
    $rows = [Collections.Generic.List[object]]::new()
    function Visit($e,$parents) {
        $c=$e.Cached; $type=$c.ControlType.ProgrammaticName; $id=$c.AutomationId; $name=$c.Name
        if ($type -eq 'ControlType.Group' -and $id -like 'TmGroupHeader_*') { $parents=@($name) }
        if ($type -eq 'ControlType.TreeItem') {
            $procId = if ($id -match '^\d+:(\d+)$') { $Matches[1] } else { '' }
            $our = @($inventory | Where-Object { [string]$_.ProcessId -eq $procId })
            if ($our.Count -or $name -match '^GoyMusic\b') { $rows.Add([pscustomobject]@{name=$name;id=$id;pid=$procId;image=$our[0].Name;parents=@($parents);onscreen=!$c.IsOffscreen}) }
            $parents=@($parents)+@($name)
        }
        foreach ($child in $e.CachedChildren) { Visit $child $parents }
    }
    Visit $root @()
    $header=$root.FindFirst([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty,'TmColMemory'))
    $memoryHeader=if ($header) { $header.Current.Name } else { 'missing' }
    $grouped=@($rows | Where-Object { $_.image -eq 'GoyMusic.exe' -and ($_.parents -match '^GoyMusic\b').Count }).Count
    $seen=@($rows | Where-Object image -eq 'GoyMusic.exe').Count
    $total=@($inventory | Where-Object Name -eq 'GoyMusic.exe').Count
    $r=[pscustomobject]@{tag=$tag;sample=$index;grouped=$grouped;seen=$seen;total=$total;rows=$rows;inventory=$inventory;taskmgrVersion=$manager.FileVersion;memoryHeader=$memoryHeader}
    $r | ConvertTo-Json -Depth 8 | Set-Content "observations/$tag-$index.json"
    $order=if ($memoryHeader -match '\bdescend') { 'memory-desc' } else { 'unverified-sort' }
    "${order}:$grouped/$seen/$total"
}
function Observe($tag) {
    # Do not count the first transient renderer set as the settled state.
    Start-Sleep -Seconds 6
    $a=Snapshot $tag 1
    Start-Sleep -Seconds 20
    $b=Snapshot $tag 2
    Start-Sleep -Seconds 4
    $c=Snapshot $tag 3
    Write-Host "${tag}: $a -> $b -> $c (nested / PID rows seen / live GoyMusic.exe)"
    $c
}
Start-Process "$env:WINDIR\System32\Taskmgr.exe"
for ($i=0;$i -lt 20;$i++) {
    $tm=Get-Process Taskmgr -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($tm) { break }
    Start-Sleep -Milliseconds 500
}
if (!$tm) { throw 'Task Manager unavailable' }
$null=Select-MemoryDescending $tm.MainWindowHandle
Start-Process (Shortcut)
$p=MainWindow '7.1.15'; $old=Observe '15-start'; Stop-Player $p
$setup16="$env:RUNNER_TEMP\GoyMusic-Setup-7.1.16.exe"
Invoke-WebRequest 'https://github.com/Anfi1/goymusic/releases/download/v7.1.16/GoyMusic-Setup-7.1.16.exe' -OutFile $setup16
if ([Convert]::ToBase64String([Convert]::FromHexString((Get-FileHash $setup16 -Algorithm SHA512).Hash)) -cne 'RbArMzXANd0Aa34in6uzza4HNzngw0mdLEj7fXkluNbLmwaZxLAtw5KzIczrI10CI0MTCECIOX2v/dYOPrBegA==') { throw 'Unexpected 7.1.16 installer' }
$s=Start-Process $setup16 -ArgumentList '/S',"/D=$dir" -Wait -PassThru
if ($s.ExitCode) { throw 'Official 7.1.16 install failed' }
$profile=Join-Path $env:APPDATA 'GoyMusic'
if (!(Test-Path $profile -PathType Container)) { throw 'Missing player profile' }
$marker=Join-Path $profile 'qa-restore-profile.txt'
$value=[guid]::NewGuid().ToString()
[IO.File]::WriteAllText($marker,$value)
$config=Join-Path $profile 'window-config.json'
$prefs=Get-Content -LiteralPath $config -Raw | ConvertFrom-Json -AsHashtable
$songs=Join-Path $env:RUNNER_TEMP 'QA music library'
$null=New-Item -ItemType Directory $songs
$prefs['songsPath']=$songs
$prefs | ConvertTo-Json | Set-Content -LiteralPath $config -Encoding utf8NoBOM
Set-Content -LiteralPath "$songs/library-probe.txt" -Value $value -NoNewline
Start-Process (Shortcut)
$new=MainWindow '7.1.16'; $cold=Observe '16-start'
$null=New-Item -ItemType Directory 'restore-kit'
Copy-Item $setup, ./tools/restore-7.1.15.* -Destination 'restore-kit'
& ./restore-kit/restore-7.1.15.cmd
if ($LASTEXITCODE) { throw "Rollback failed: $LASTEXITCODE" }
$back=MainWindow '7.1.15' $new.Id
if ([IO.File]::ReadAllText($marker) -cne $value) { throw 'Player profile lost' }
if ((Get-Content $config -Raw | ConvertFrom-Json).songsPath -ne $songs -or [IO.File]::ReadAllText("$songs/library-probe.txt") -cne $value) { throw 'Music library path or contents changed' }
$rolled=Observe '15-restored'
Stop-Player $back
"counts=Nested/seen/live: 15 $old, 16 $cold, restored 15 $rolled" >> $env:GITHUB_OUTPUT
