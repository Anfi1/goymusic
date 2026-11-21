# Run from the repo root in an elevated Windows x64 PowerShell 7 session after npm ci and npm run build.
# The runner temporarily trusts only this build's public leaf certificate for SignTool verification.
#Requires -Version 7.2
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot/../..").Path
$out = Join-Path $root 'msix-out'
if (Test-Path $out) { throw "Output already exists: $out. Move it before building." }
$sdk = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Directory |
    Where-Object { $_.Name -as [version] -and (Test-Path "$($_.FullName)/x64/makeappx.exe") -and (Test-Path "$($_.FullName)/x64/signtool.exe") } |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (!$sdk) { throw 'Install the x64 Windows SDK packaging and signing tools.' }
$makeappx = "$($sdk.FullName)/x64/makeappx.exe"
$signtool = "$($sdk.FullName)/x64/signtool.exe"
$sevenZip = (Get-Command 7z.exe -ErrorAction Stop).Source
$work = (New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid()))).FullName
$cert = $null
$trusted = $null
Push-Location $root
try {
    # Extract just the official Python tree without executing NSIS or registering anything on the host.
    $base = 'https://github.com/Anfi1/goymusic/releases/download/v7.1.15'
    $name = 'GoyMusic-Setup-7.1.15.exe'
    $expected = '/uqYTibZ3lAr4dUWKgk3Q6gGJf4MT70OiEjKjXmbKgaAI1eeLhexFD0fhi0Int33wyL9tsT6To/clEp+OqlXTw=='
    Invoke-WebRequest "$base/latest.yml" -OutFile "$work/latest.yml"
    $feed = Get-Content "$work/latest.yml"
    foreach ($line in @('version: 7.1.15', "path: $name", "sha512: $expected")) {
        if ($feed -cnotcontains $line) { throw "Unexpected stable update manifest: $line missing" }
    }
    Invoke-WebRequest "$base/$name" -OutFile "$work/$name"
    $actual = [Convert]::ToBase64String([Convert]::FromHexString((Get-FileHash "$work/$name" -Algorithm SHA512).Hash))
    if ($actual -cne $expected) { throw 'Stable installer SHA-512 mismatch' }
    & $sevenZip x "$work/$name" "-o$work/nsis" -r 'app-64.7z' -y
    if ($LASTEXITCODE) { throw 'NSIS payload extraction failed' }
    $archives = @(Get-ChildItem "$work/nsis" -Recurse -File -Filter app-64.7z)
    if ($archives.Count -ne 1) { throw 'Expected one x64 application archive' }

    & ./node_modules/.bin/electron-builder.cmd --win dir --x64 --publish never '-c.appId=GoyMusic.GroupingLab' '-c.productName=GoyMusic MSIX Lab' "-c.directories.output=$work/builder"
    if ($LASTEXITCODE) { throw 'electron-builder failed' }
    $stage = "$work/builder/win-unpacked"
    Remove-Item "$stage/resources/python" -Recurse -Force
    & $sevenZip x $archives[0].FullName "-o$stage" 'resources\python\*' -y
    if ($LASTEXITCODE) { throw 'Stable Python payload extraction failed' }
    $update = "$stage/resources/app-update.yml"
    if (Test-Path $update) { Remove-Item $update }
    foreach ($relative in @('GoyMusic MSIX Lab.exe', 'resources/app.asar', 'resources/python/api.py', 'resources/python/js_bridge.py', 'resources/python/bin/python.exe')) {
        if (!(Test-Path "$stage/$relative" -PathType Leaf)) { throw "Missing package input: $relative" }
    }
    Copy-Item "$PSScriptRoot/grouping_backend.py" "$stage/resources/python/grouping_backend.py"
    if (!(Get-ChildItem "$stage/resources/python/bin/Lib/site-packages/nodejs_wheel" -Filter node.exe -File -Recurse)) { throw 'Missing packaged Node runtime' }

    Copy-Item "$PSScriptRoot/AppxManifest.xml" $stage
    Add-Type -AssemblyName System.Drawing
    $assets = (New-Item -ItemType Directory "$stage/Assets").FullName
    $icon = [Drawing.Image]::FromFile("$root/build/icon.png")
    try {
        foreach ($item in @{ StoreLogo = 50; Square44x44Logo = 44; Square150x150Logo = 150 }.GetEnumerator()) {
            $bitmap = [Drawing.Bitmap]::new($item.Value, $item.Value)
            try {
                $g = [Drawing.Graphics]::FromImage($bitmap)
                try {
                    $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                    $g.DrawImage($icon, 0, 0, $bitmap.Width, $bitmap.Height)
                } finally { $g.Dispose() }
                $bitmap.Save("$assets/$($item.Key).png", [Drawing.Imaging.ImageFormat]::Png)
            } finally { $bitmap.Dispose() }
        }
    } finally { $icon.Dispose() }

    $result = (New-Item -ItemType Directory "$work/result").FullName
    $package = "$result/GoyMusic-Lab-x64.msix"
    $public = "$result/GoyMusic-Lab.cer"
    & $makeappx pack /d $stage /p $package /h SHA256
    if ($LASTEXITCODE) { throw 'MakeAppx failed' }
    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=GoyMusic Grouping Lab' -CertStoreLocation Cert:\CurrentUser\My -KeyExportPolicy NonExportable -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddDays(30) -TextExtension '2.5.29.19={critical}{text}ca=false'
    Export-Certificate -Cert $cert -FilePath $public | Out-Null
    & $signtool sign /fd SHA256 /s My /sha1 $cert.Thumbprint $package
    if ($LASTEXITCODE) { throw 'MSIX signing failed' }
    $trusted = Import-Certificate -FilePath $public -CertStoreLocation Cert:\LocalMachine\TrustedPeople
    & $signtool verify /pa /v $package
    if ($LASTEXITCODE) { throw 'MSIX signature verification failed' }
    & $makeappx unpack /p $package /d "$work/verified"
    if ($LASTEXITCODE) { throw 'Signed MSIX payload unpack/validation failed' }
    Move-Item $result $out
} finally {
    try {
        if ($trusted) { Remove-Item "Cert:\LocalMachine\TrustedPeople\$($trusted.Thumbprint)" -Force }
    } finally {
        try {
            if ($cert) { Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -DeleteKey -Force }
        } finally {
            Pop-Location
            Remove-Item $work -Recurse -Force
        }
    }
}
