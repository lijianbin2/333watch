# 跑全部回归测试。用法：powershell -ExecutionPolicy Bypass -File scripts\test.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$files = @('background.js', 'add-monitor.js', 'picker.js', 'offscreen.js')
foreach ($f in $files) {
  node --check $f
  if ($LASTEXITCODE -ne 0) { throw "syntax check failed: $f" }
}
Write-Host "syntax ok: $($files -join ', ')"

$failed = @()
Get-ChildItem tests\*.test.cjs | ForEach-Object {
  Write-Host "--- $($_.Name) ---"
  node $_.FullName
  if ($LASTEXITCODE -ne 0) { $failed += $_.Name }
}

if ($failed.Count -gt 0) {
  throw "tests failed: $($failed -join ', ')"
}
Write-Host "all tests passed"
