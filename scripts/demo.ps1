# demo.ps1 — reproducible bring-up for switchyard.
# Builds the binaries, starts a yard on 127.0.0.1:4780, drives a real
# subscribe/publish exchange through spur, and cleans up.
# Usage:  .\scripts\demo.ps1   (from the repo root or anywhere)
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$binDir = "C:\Users\sukru\AppData\Local\Temp\switchyard-demo"
New-Item -ItemType Directory -Force $binDir | Out-Null

$go = "go"
if (Get-Command go -ErrorAction SilentlyContinue) { } elseif (Test-Path "C:\Program Files\Go\bin\go.exe") {
    $env:PATH = "C:\Program Files\Go\bin;$env:PATH"
}

Write-Host "== building =="
Push-Location $repoRoot
go build -o (Join-Path $binDir "switchyard.exe") ./cmd/switchyard
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "switchyard build failed" }
go build -o (Join-Path $binDir "spur.exe") ./cmd/spur
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "spur build failed" }
Pop-Location

$yardExe = Join-Path $binDir "switchyard.exe"
$spurExe = Join-Path $binDir "spur.exe"
$addr = "127.0.0.1:4780"
$logOut = Join-Path $binDir "yard.log"

Write-Host "== starting yard at $addr =="
$yard = Start-Process -FilePath $yardExe -ArgumentList "--addr", $addr `
    -RedirectStandardError $logOut -RedirectStandardOutput (Join-Path $binDir "yard.out.log") `
    -PassThru
Start-Sleep -Milliseconds 1200

try {
    Write-Host "== spur ping =="
    & $spurExe ping
    if ($LASTEXITCODE -ne 0) { throw "ping failed" }

    Write-Host "== spur sub (background) =="
    $subLog = Join-Path $binDir "sub.log"
    $sub = Start-Process -FilePath powershell -ArgumentList "-NoProfile", "-Command", `
        "& '$spurExe' sub -count 2 'orders.*.paid'" `
        -RedirectStandardOutput $subLog -RedirectStandardError (Join-Path $binDir "sub.err.log") `
        -PassThru
    Start-Sleep -Milliseconds 1200

    Write-Host "== spur pub x2 =="
    & $spurExe pub 'orders.e9.paid' 'box 42 left the dock'
    if ($LASTEXITCODE -ne 0) { throw "pub 1 failed" }
    & $spurExe pub 'orders.c7.paid' 'box 43 is next'
    if ($LASTEXITCODE -ne 0) { throw "pub 2 failed" }

    Start-Sleep -Milliseconds 1500
    if (-not $sub.HasExited) { Stop-Process -Id $sub.Id -Force }

    Write-Host "== deliveries received by the subscriber =="
    Get-Content $subLog

    Write-Host "== yard log (tail) =="
    Get-Content $logOut -Tail 10
}
finally {
    if ($yard -and -not $yard.HasExited) {
        Write-Host "== stopping yard =="
        # A graceful stop: the yard answers SIG TERM/CTRL signals; on
        # Windows just kill the process — the socket close is the same.
        Stop-Process -Id $yard.Id -Force
    }
}

Write-Host "`ndemo complete. artifacts in $binDir"
