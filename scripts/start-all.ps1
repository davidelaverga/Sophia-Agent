<#
.SYNOPSIS
  Start all Sophia services in one terminal.
.DESCRIPTION
  Launches LangGraph, Gateway, Voice Server, and Frontend as background jobs.
  Use 'sophia-stop' to tear down, 'sophia-logs' to tail output.
#>
param(
    [switch]$Stop
)

$ErrorActionPreference = "Continue"
$ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# ---------------------------------------------------------------------------
# Stop helper
# ---------------------------------------------------------------------------
function Stop-AllServices {
    Write-Host "`n[sophia] Stopping all services..." -ForegroundColor Yellow
    Get-Job -Name sophia-* -ErrorAction SilentlyContinue | Stop-Job -PassThru | Remove-Job -Force
    # Kill any orphan processes on our ports
    foreach ($port in 2024, 3000, 8000, 8001) {
        $conn = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
                Where-Object State -eq 'Listen'
        if ($conn) {
            $conn | ForEach-Object {
                Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
            }
        }
    }
    Start-Sleep -Seconds 1
    Write-Host "[sophia] All services stopped." -ForegroundColor Green
}

if ($Stop) {
    Stop-AllServices
    return
}

# ---------------------------------------------------------------------------
# Pre-flight: kill anything on our ports
# ---------------------------------------------------------------------------
Stop-AllServices

# ---------------------------------------------------------------------------
# 1. LangGraph  (port 2024)
# ---------------------------------------------------------------------------
Write-Host "[sophia] Starting LangGraph on :2024 ..." -ForegroundColor Cyan
$lgJob = Start-Job -Name sophia-langgraph -ScriptBlock {
    Set-Location $using:ROOT\backend
    & uv run langgraph dev --no-browser --allow-blocking --no-reload 2>&1
}

# Wait for LangGraph to be ready before starting services that depend on it
Write-Host "[sophia] Waiting for LangGraph ..." -ForegroundColor DarkGray
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:2024/ok" -TimeoutSec 2 -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
}
if (-not $ready) {
    Write-Host "[sophia] WARNING: LangGraph not ready after 30s, continuing anyway..." -ForegroundColor Red
} else {
    Write-Host "[sophia] LangGraph ready." -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 2. Gateway  (port 8001)
# ---------------------------------------------------------------------------
Write-Host "[sophia] Starting Gateway on :8001 ..." -ForegroundColor Cyan
$gwJob = Start-Job -Name sophia-gateway -ScriptBlock {
    Set-Location $using:ROOT\backend
    $env:PYTHONPATH = "."
    $env:SOPHIA_AUTH_BACKEND_URL = "http://127.0.0.1:3000"
    & uv run uvicorn app.gateway.app:app --host 0.0.0.0 --port 8001 2>&1
}

# ---------------------------------------------------------------------------
# 3. Voice server  (port 8000)
# ---------------------------------------------------------------------------
Write-Host "[sophia] Starting Voice server on :8000 ..." -ForegroundColor Cyan
$voiceJob = Start-Job -Name sophia-voice -ScriptBlock {
    Set-Location $using:ROOT
    & "$using:ROOT\voice\.venv\Scripts\python.exe" -m voice.server serve --port 8000 2>&1
}

# ---------------------------------------------------------------------------
# 4. Frontend  (port 3000)
# ---------------------------------------------------------------------------
Write-Host "[sophia] Starting Frontend on :3000 ..." -ForegroundColor Cyan
$feJob = Start-Job -Name sophia-frontend -ScriptBlock {
    Set-Location "$using:ROOT\frontend"
    & pnpm run dev 2>&1
}

# ---------------------------------------------------------------------------
# Wait for all ports
# ---------------------------------------------------------------------------
Start-Sleep -Seconds 3
Write-Host ""
Write-Host "========================================" -ForegroundColor White
Write-Host "  Sophia Services" -ForegroundColor White
Write-Host "========================================" -ForegroundColor White

$services = @(
    @{ Name = "LangGraph";  Port = 2024; Job = "sophia-langgraph" },
    @{ Name = "Gateway";    Port = 8001; Job = "sophia-gateway" },
    @{ Name = "Voice";      Port = 8000; Job = "sophia-voice" },
    @{ Name = "Frontend";   Port = 3000; Job = "sophia-frontend" }
)

foreach ($svc in $services) {
    $conn = Get-NetTCPConnection -LocalPort $svc.Port -ErrorAction SilentlyContinue |
            Where-Object State -eq 'Listen'
    $job = Get-Job -Name $svc.Job -ErrorAction SilentlyContinue
    if ($conn -and $job.State -eq 'Running') {
        Write-Host "  [OK] $($svc.Name) -> http://localhost:$($svc.Port)" -ForegroundColor Green
    } else {
        Write-Host "  [!!] $($svc.Name) :$($svc.Port) - NOT READY (check: Receive-Job -Name $($svc.Job))" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "Commands:" -ForegroundColor DarkGray
Write-Host "  Receive-Job -Name sophia-langgraph  # view LangGraph logs" -ForegroundColor DarkGray
Write-Host "  Receive-Job -Name sophia-gateway     # view Gateway logs" -ForegroundColor DarkGray
Write-Host "  Receive-Job -Name sophia-voice       # view Voice logs" -ForegroundColor DarkGray
Write-Host "  Receive-Job -Name sophia-frontend    # view Frontend logs" -ForegroundColor DarkGray
Write-Host "  .\scripts\start-all.ps1 -Stop        # stop everything" -ForegroundColor DarkGray
Write-Host ""
