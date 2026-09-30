$ErrorActionPreference = 'Stop'
$version = '0.6.43'
$root = Split-Path -Parent $PSScriptRoot
$zip = Join-Path (Split-Path -Parent $root) "333-watcher-$version.zip"
$files = @(
  '.gitignore',
  'add-monitor.css',
  'add-monitor.html',
  'add-monitor.js',
  'background.js',
  'icons',
  'manifest.json',
  'offscreen.html',
  'offscreen.js',
  'picker.js',
  'PRIVACY.md',
  'README.md'
)
Push-Location $root
try {
  foreach ($f in $files) {
    if (-not (Test-Path -LiteralPath $f)) { throw "missing package file: $f" }
  }
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  Compress-Archive -Path $files -DestinationPath $zip -CompressionLevel Optimal -Force
  Write-Output "created: $zip"
  tar -tf $zip
} finally {
  Pop-Location
}
