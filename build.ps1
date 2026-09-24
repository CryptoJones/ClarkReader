# Assemble a loadable extension directory per browser, on Windows.
#
# Same job as build.sh, which needs bash, python3 and zip. This needs only PowerShell.
# Chrome and Firefox differ only in the manifest.
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$src = Join-Path $here 'extension'
$out = Join-Path $here 'dist'

if (Test-Path $out) { Remove-Item -Recurse -Force $out }

foreach ($browser in 'chrome', 'firefox') {
    $dest = Join-Path $out $browser
    New-Item -ItemType Directory -Force $dest | Out-Null
    # Everything but the manifests, then the right manifest as manifest.json.
    Get-ChildItem $src -Exclude 'manifest*.json' | Copy-Item -Destination $dest -Recurse -Force
    $manifest = if ($browser -eq 'chrome') { 'manifest.json' } else { 'manifest.firefox.json' }
    Copy-Item (Join-Path $src $manifest) (Join-Path $dest 'manifest.json') -Force
    Write-Host "built $dest"

    # The store package: the directory's contents with the manifest at the zip root.
    $version = (Get-Content (Join-Path $dest 'manifest.json') -Raw | ConvertFrom-Json).version
    $zip = Join-Path $out "clarkreader-$version-$browser.zip"
    # Written by hand: Windows PowerShell 5.1's Compress-Archive stores backslash paths,
    # which the stores reject.
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::Open($zip, 'Create')
    try {
        $root = (Resolve-Path $dest).Path.TrimEnd('\') + '\'
        foreach ($file in Get-ChildItem $dest -Recurse -File) {
            $name = $file.FullName.Substring($root.Length).Replace('\', '/')
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $name)
        }
    } finally { $archive.Dispose() }
    Write-Host "packed $zip"
}

Write-Host @'

Load them:
  Chrome   chrome://extensions -> Developer mode -> Load unpacked -> dist\chrome
  Firefox  about:debugging#/runtime/this-firefox -> Load Temporary Add-on
           -> pick dist\firefox\manifest.json
'@
