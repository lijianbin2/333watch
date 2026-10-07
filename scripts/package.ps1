$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
$version = $manifest.version
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
  # exclude sensitive
  if (Test-Path -LiteralPath '.cws-credentials') {
    Write-Warning "exclude .cws-credentials from package (sensitive)"
  }
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  Compress-Archive -Path $files -DestinationPath $zip -CompressionLevel Optimal -Force
  Write-Output "created: $zip ($version)"
  tar -tf $zip
} finally {
  Pop-Location
}
