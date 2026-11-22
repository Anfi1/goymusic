#requires -Version 7.4
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:GITHUB_REF -ne 'refs/heads/qa/official-group-716') { throw 'Lab builder requires the diagnostic branch on a hosted Windows runner' }

$name = 'GoyMusic.ExternalIdentityTest'
$publisher = 'CN=GoyMusic External Identity Test'
$appId = 'Player'
$output = Join-Path $env:GITHUB_WORKSPACE 'identity-kit'
if (Test-Path -LiteralPath $output) { throw "Refusing to overwrite $output" }
$sdkBin = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
$sdk = Get-ChildItem $sdkBin -Directory -Filter '10.0.*' | Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName 'x64' } | Where-Object {
        (Test-Path "$_\mt.exe") -and (Test-Path "$_\makeappx.exe") -and (Test-Path "$_\signtool.exe")
    } | Select-Object -First 1
if (!$sdk) { throw 'No complete x64 Windows SDK toolset' }

$work = (New-Item -ItemType Directory (Join-Path $env:RUNNER_TEMP ([guid]::NewGuid()))).FullName
$cert = $null
try {
    $kit = (New-Item -ItemType Directory "$work\identity-kit").FullName
    $packageDir = (New-Item -ItemType Directory "$work\package").FullName
    $setup = "$work\GoyMusic-Setup-7.1.16.exe"
    Invoke-WebRequest 'https://github.com/Anfi1/goymusic/releases/download/v7.1.16/GoyMusic-Setup-7.1.16.exe' -OutFile $setup
    $digest = [Convert]::ToBase64String([Convert]::FromHexString((Get-FileHash $setup -Algorithm SHA512).Hash))
    if ($digest -cne 'RbArMzXANd0Aa34in6uzza4HNzngw0mdLEj7fXkluNbLmwaZxLAtw5KzIczrI10CI0MTCECIOX2v/dYOPrBegA==') { throw 'Unexpected official 7.1.16 installer SHA512' }
    & 7z.exe e $setup -r app-64.7z "-o$work"
    & 7z.exe e "$work\app-64.7z" GoyMusic.exe "-o$kit"
    $exe = "$kit\GoyMusic.exe"

    # Amend the extracted RT_MANIFEST/#1, not a replacement assembly template.
    $manifest = "$work\player.manifest"
    & "$sdk\mt.exe" -nologo "-inputresource:$exe;#1" "-out:$manifest"
    $original = [Xml.Linq.XElement]::Load($manifest)
    $msixName = [Xml.Linq.XName]::Get('msix', 'urn:schemas-microsoft-com:msix.v1')
    if ($original.Element($msixName)) { throw 'Stock EXE already has package identity metadata' }
    $identity = [Xml.Linq.XElement]::new($msixName)
    $identity.SetAttributeValue('packageName', $name)
    $identity.SetAttributeValue('publisher', $publisher)
    $identity.SetAttributeValue('applicationId', $appId)
    $updated = [Xml.Linq.XElement]::new($original)
    $updated.Add($identity)
    $updated.Save($manifest)
    & "$sdk\mt.exe" -nologo -manifest $manifest "-outputresource:$exe;#1"
    & "$sdk\mt.exe" -nologo "-inputresource:$exe;#1" "-out:$manifest"
    $embedded = [Xml.Linq.XElement]::Load($manifest)
    $node = $embedded.Element($msixName)
    if (!$node -or $node.Attribute('publisher').Value -cne $publisher -or $node.Attribute('packageName').Value -cne $name -or
        $node.Attribute('applicationId').Value -cne $appId) { throw 'Embedded identity did not round-trip' }
    $node.Remove()
    # Namespace declarations can move during serialization; compare expanded names and attributes.
    foreach ($root in $original,$embedded) {
        foreach ($element in $root.DescendantsAndSelf()) {
            foreach ($attr in @($element.Attributes())) { if ($attr.IsNamespaceDeclaration) { $attr.Remove() } }
        }
    }
    if (![Xml.Linq.XNode]::DeepEquals($original, $embedded)) { throw 'Embedding identity changed the original manifest' }

    # Only the manifest and logo are packaged. The installed EXE remains external.
    Copy-Item "$PSScriptRoot\..\..\build\icon.png" "$packageDir\logo.png"
    @"
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities" IgnorableNamespaces="uap uap10 rescap">
  <Identity Name="$name" Publisher="$publisher" Version="7.1.16.0" ProcessorArchitecture="neutral" />
  <Properties><DisplayName>GoyMusic</DisplayName><PublisherDisplayName>GoyMusic Identity Lab</PublisherDisplayName><Logo>logo.png</Logo><uap10:AllowExternalContent>true</uap10:AllowExternalContent></Properties>
  <Resources><Resource Language="en-us" /></Resources>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" /></Dependencies>
  <Capabilities><rescap:Capability Name="runFullTrust" /><rescap:Capability Name="unvirtualizedResources" /></Capabilities>
  <Applications><Application Id="$appId" Executable="GoyMusic.exe" uap10:TrustLevel="mediumIL" uap10:RuntimeBehavior="win32App">
    <uap:VisualElements AppListEntry="none" DisplayName="GoyMusic" Description="GoyMusic external identity test" BackgroundColor="transparent" Square150x150Logo="logo.png" Square44x44Logo="logo.png" />
  </Application></Applications>
</Package>
"@ | Set-Content "$packageDir\AppxManifest.xml" -Encoding utf8NoBOM
    $msix = "$kit\identity.msix"
    & "$sdk\makeappx.exe" pack /d $packageDir /p $msix /h SHA256 /nv

    $cert = New-SelfSignedCertificate -Type Custom -Subject $publisher -CertStoreLocation Cert:\CurrentUser\My `
        -KeyExportPolicy NonExportable -KeyUsage DigitalSignature -HashAlgorithm SHA256 -NotAfter (Get-Date).AddDays(2) `
        -TextExtension '2.5.29.37={text}1.3.6.1.5.5.7.3.3','2.5.29.19={text}'
    $thumb = $cert.Thumbprint
    $null = Export-Certificate -Cert $cert -FilePath "$kit\lab.cer" -Type CERT
    & "$sdk\signtool.exe" sign /sha1 $thumb /fd SHA256 $exe $msix
    # SignTool's Authenticode policy needs a trusted chain for the PE as well as the MSIX.
    $null = Import-Certificate -FilePath "$kit\lab.cer" -CertStoreLocation Cert:\LocalMachine\Root
    try { & "$sdk\signtool.exe" verify /pa /v $exe $msix }
    finally { Remove-Item "Cert:\LocalMachine\Root\$thumb" }
    Get-FileHash -Algorithm SHA256 -LiteralPath $exe,$msix,"$kit\lab.cer" | Format-List Path,Hash
    Move-Item -LiteralPath $kit -Destination $output
} finally {
    if ($cert) { Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -DeleteKey }
    Remove-Item -LiteralPath $work -Recurse -Force
}
