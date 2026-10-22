<#
A throwaway yard, one measuring rod, three honest numbers.

Spins a scratch yard on 127.0.0.1:4799 with its own fresh data dir, then
lets yardstick run every scenario against it, then tears the yard down.
The dirt it makes is temp-dir dirt and lives no longer than the run.

The settings are the yard's defaults: per-record fsync on, one publisher
awaiting each receipt, the counting reader sized so nothing gets dropped.
Record the numbers + the machine you ran them on when you publish them.

Usage:
  powershell -File scripts\bench.ps1 [-Rows 2000] [-Payload 128]
#>
param(
    [int]$Rows = 2000,
    [int]$Payload = 128,
    [string]$Addr = "127.0.0.1:4799"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root "bin"

go build -o "$bin\switchyard.exe" (Join-Path $root "cmd\switchyard")
if ($LASTEXITCODE -ne 0) { throw "switchyard build failed" }
go build -o "$bin\yardstick.exe" (Join-Path $root "cmd\yardstick")
if ($LASTEXITCODE -ne 0) { throw "yardstick build failed" }

$data = Join-Path $env:TEMP "yardstick-bench-$([guid]::NewGuid().ToString("N"))"
$yard = Start-Process -FilePath "$bin\switchyard.exe" `
    -ArgumentList "-addr", $Addr, "-data-dir", $data `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput "$env:TEMP\yardstick-bench.out" `
    -RedirectStandardError "$env:TEMP\yardstick-bench.err"
Start-Sleep -Milliseconds 900

try {
    & "$bin\yardstick.exe" -addr $Addr -n $Rows -payload $Payload
    if ($LASTEXITCODE -ne 0) { throw "yardstick failed" }
}
finally {
    Stop-Process -Id $yard.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 400
    Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue
}
