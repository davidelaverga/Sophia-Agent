<#
.SYNOPSIS
    Start all Sophia voice services in development mode.

.DESCRIPTION
    Launches LangGraph, Voice Server, Gateway, and Frontend in background jobs.
    Logs from each service are written to logs/*.log.
    Press Ctrl+C to stop all services.

.EXAMPLE
    .\scripts\sophia-dev.ps1
#>

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

Push-Location $RepoRoot
try {

# ── Config ────────────────────────────────────────────────────────────────────

$services = @(
    @{ Name = "LangGraph";  Port = 2024; Dir = "backend";               Cmd = "uv run langgraph dev --no-browser --allow-blocking --no-reload" }
    @{ Name = "Voice";      Port = 8000; Dir = ".";                     Cmd = "voice\.venv\Scripts\python.exe -m voice.server serve --port 8000" }
    @{ Name = "Gateway";    Port = 8001; Dir = "backend";               Cmd = "uv run uvicorn app.gateway.app:app --host 0.0.0.0 --port 8001" }
    @{ Name = "Frontend";   Port = 3000; Dir = "AI-companion-mvp-front"; Cmd = "npm run dev" }
)

# ── Helpers ───────────────────────────────────────────────────────────────────

function Test-PortOpen([int]$Port, [int]$TimeoutMs = 500) {
    try {
        $tcp = [System.Net.Sockets.TcpClient]::new()
        $result = $tcp.BeginConnect("127.0.0.1", $Port, $null, $null)
        $waited = $result.AsyncWaitHandle.WaitOne($TimeoutMs)
        if ($waited -and $tcp.Connected) { $tcp.Close(); return $true }
        $tcp.Close(); return $false
    } catch { return $false }
}

function Wait-ForPort([int]$Port, [string]$Label, [int]$MaxSeconds = 90) {
    $elapsed = 0
    while ($elapsed -lt $MaxSeconds) {
        if (Test-PortOpen $Port) {
            Write-Host "  [OK] $Label ready on :$Port" -ForegroundColor Green
            return $true
        }
        Start-Sleep -Seconds 2
        $elapsed += 2
        if ($elapsed % 10 -eq 0) { Write-Host "  ... waiting for $Label (:$Port) — ${elapsed}s" -ForegroundColor DarkGray }
    }
    Write-Host "  [FAIL] $Label did not start on :$Port within ${MaxSeconds}s" -ForegroundColor Red
    Write-Host "         Check logs/$($Label.ToLower()).log" -ForegroundColor Yellow
    return $false
}

# ── Banner ────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Sophia Voice — Development Launcher" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# ── Pre-flight: kill stale processes on our ports ─────────────────────────────

foreach ($svc in $services) {
    if (Test-PortOpen $svc.Port) {
        Write-Host "  Port $($svc.Port) in use — stopping stale $($svc.Name)..." -ForegroundColor Yellow
        $procs = Get-NetTCPConnection -LocalPort $svc.Port -ErrorAction SilentlyContinue |
                 Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($processId in $procs) {
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1
    }
}

# ── Start services ────────────────────────────────────────────────────────────

New-Item -ItemType Directory -Path "logs" -Force | Out-Null
$jobs = @()

foreach ($svc in $services) {
    $dir  = Join-Path $RepoRoot $svc.Dir
    $log  = Join-Path $RepoRoot "logs" "$($svc.Name.ToLower()).log"
    $cmd  = $svc.Cmd
    $name = $svc.Name

    Write-Host "  Starting $name..." -ForegroundColor White

    # Set PYTHONPATH for gateway
    $envBlock = @{ PYTHONPATH = $dir }

    $job = Start-Job -Name $name -ScriptBlock {
        param($Dir, $Cmd, $Log, $EnvBlock)
        Set-Location $Dir
        foreach ($k in $EnvBlock.Keys) { [Environment]::SetEnvironmentVariable($k, $EnvBlock[$k]) }
        & cmd /c "$Cmd > `"$Log`" 2>&1"
    } -ArgumentList $dir, $cmd, $log, $envBlock

    $jobs += $job
}

# ── Wait for each port ────────────────────────────────────────────────────────

Write-Host ""
$allOk = $true
foreach ($svc in $services) {
    if (-not (Wait-ForPort $svc.Port $svc.Name 90)) {
        $allOk = $false
    }
}

if (-not $allOk) {
    Write-Host ""
    Write-Host "Some services failed to start. Check logs/ for details." -ForegroundColor Red
    Write-Host "Stopping everything..." -ForegroundColor Yellow
    $jobs | Stop-Job -ErrorAction SilentlyContinue
    $jobs | Remove-Job -Force -ErrorAction SilentlyContinue
    Pop-Location
    exit 1
}

# ── Ready ─────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  Sophia is ready!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Frontend:  http://localhost:3000" -ForegroundColor White
Write-Host "  Gateway:   http://localhost:8001" -ForegroundColor White
Write-Host "  Voice:     http://localhost:8000" -ForegroundColor White
Write-Host "  LangGraph: http://localhost:2024" -ForegroundColor White
Write-Host ""
Write-Host "  Logs:" -ForegroundColor DarkGray
Write-Host "    logs/langgraph.log   logs/voice.log" -ForegroundColor DarkGray
Write-Host "    logs/gateway.log     logs/frontend.log" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Press Ctrl+C to stop all services" -ForegroundColor Yellow
Write-Host ""

# ── Keep alive until Ctrl+C ──────────────────────────────────────────────────

try {
    while ($true) {
        # Check for dead jobs
        foreach ($j in $jobs) {
            if ($j.State -eq "Failed" -or $j.State -eq "Completed") {
                $svc = $services | Where-Object { $_.Name -eq $j.Name } | Select-Object -First 1
                Write-Host "  [!] $($j.Name) exited unexpectedly — check logs/$($j.Name.ToLower()).log" -ForegroundColor Red
            }
        }
        Start-Sleep -Seconds 5
    }
} finally {
    Write-Host ""
    Write-Host "Shutting down..." -ForegroundColor Yellow
    $jobs | Stop-Job -ErrorAction SilentlyContinue
    $jobs | Remove-Job -Force -ErrorAction SilentlyContinue
    # Also kill anything still on our ports
    foreach ($svc in $services) {
        $procs = Get-NetTCPConnection -LocalPort $svc.Port -ErrorAction SilentlyContinue |
                 Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($processId in $procs) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
    }
    Write-Host "  All services stopped." -ForegroundColor Green
}

} finally { Pop-Location }
