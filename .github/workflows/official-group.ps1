$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or (Get-CimInstance Win32_OperatingSystem).ProductType -ne 1) { throw 'Requires a disposable Windows client runner' }
$null = New-Item -ItemType Directory observations
$dir = "$env:RUNNER_TEMP\GoyMusic-official"
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
        if ($type -eq 'ControlType.TreeItem' -and $parents.Count) {
            $procId = if ($id -match '^\d+:(\d+)$') { $Matches[1] } else { '' }
            $our = @($inventory | Where-Object { [string]$_.ProcessId -eq $procId })
            if ($our.Count -or $name -match '^GoyMusic\b') { $rows.Add([pscustomobject]@{name=$name;id=$id;pid=$procId;image=$our[0].Name;parents=@($parents);onscreen=!$c.IsOffscreen}) }
            $parents=@($parents)+@($name)
        }
        foreach ($child in $e.CachedChildren) { Visit $child $parents }
    }
    Visit $root @()
    $grouped=@($rows | Where-Object { $_.image -eq 'GoyMusic.exe' -and ($_.parents -match '^GoyMusic\b').Count }).Count
    $seen=@($rows | Where-Object image -eq 'GoyMusic.exe').Count
    $total=@($inventory | Where-Object Name -eq 'GoyMusic.exe').Count
    $r=[pscustomobject]@{tag=$tag;sample=$index;grouped=$grouped;seen=$seen;total=$total;rows=$rows;inventory=$inventory;taskmgrVersion=$manager.FileVersion}
    $r | ConvertTo-Json -Depth 8 | Set-Content "observations/$tag-$index.json"
    "$grouped/$seen/$total"
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
Start-Process (Shortcut)
$p=MainWindow '7.1.15'; $old=Observe '15-start'; Stop-Player $p
$p=Start-Process $exe -ArgumentList '--devtools','--remote-debugging-port=9222' -PassThru
$env:EXPECTED='7.1.16'; node .github/workflows/check-installed-update.cjs
if ($LASTEXITCODE) { throw 'Actual in-app upgrade failed' }
$new=MainWindow '7.1.16' $p.Id; $after=Observe '16-updated'; Stop-Player $new
Start-Process (Shortcut)
$new=MainWindow '7.1.16'; $cold=Observe '16-start'; Stop-Player $new
"counts=Nested/seen/live Electron processes - 15 Start $old, 16 updater $after, 16 Start $cold" >> $env:GITHUB_OUTPUT
