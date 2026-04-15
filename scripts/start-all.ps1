<#
.SYNOPSIS
    Start all Sophia services in detached mode.
.DESCRIPTION
    Launches LangGraph, Gateway, Voice Server, and Frontend as detached child
    processes, writes logs to logs/*.log, returns control to the terminal when
    startup checks finish, and stops services via .\scripts\start-all.ps1 -Stop.
#>
param(
    [switch]$Stop
)

$ErrorActionPreference = "Continue"
$ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LOG_DIR = Join-Path $ROOT "logs"
$STATE_FILE = Join-Path $LOG_DIR "start-all.state.json"
$PS_EXECUTABLE = (Get-Process -Id $PID -ErrorAction SilentlyContinue).Path
if (-not $PS_EXECUTABLE) {
    $PS_EXECUTABLE = "powershell.exe"
}

# ---------------------------------------------------------------------------
# Stop helper
# ---------------------------------------------------------------------------
function Stop-AllServices {
    Write-Host "`n[sophia] Stopping all services..." -ForegroundColor Yellow
    Get-Job -Name sophia-* -ErrorAction SilentlyContinue | Stop-Job -PassThru | Remove-Job -Force

    foreach ($service in Get-ServiceState) {
        if ($service.Pid) {
            Stop-Process -Id $service.Pid -Force -ErrorAction SilentlyContinue
        }
    }

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

    Remove-ServiceState
    Start-Sleep -Seconds 1
    Write-Host "[sophia] All services stopped." -ForegroundColor Green
}

function ConvertTo-SingleQuotedPowerShellLiteral {
    param(
        [string]$Value
    )

    return "'" + ($Value -replace "'", "''") + "'"
}

function ConvertFrom-DotEnvValue {
    param(
        [string]$Value
    )

    $trimmed = $Value.Trim()
    if (-not $trimmed) {
        return ""
    }

    if (($trimmed.StartsWith('"') -and $trimmed.EndsWith('"')) -or ($trimmed.StartsWith("'") -and $trimmed.EndsWith("'"))) {
        return $trimmed.Substring(1, $trimmed.Length - 2)
    }

    $commentIndex = $trimmed.IndexOf(" #")
    if ($commentIndex -ge 0) {
        $trimmed = $trimmed.Substring(0, $commentIndex).TrimEnd()
    }

    return $trimmed
}

function Import-DotEnvFiles {
    param(
        [string[]]$Paths
    )

    $loadedFiles = @()

    foreach ($path in $Paths) {
        if (-not (Test-Path $path)) {
            continue
        }

        foreach ($rawLine in Get-Content -Path $path -ErrorAction SilentlyContinue) {
            $line = $rawLine.Trim()
            if (-not $line -or $line.StartsWith("#")) {
                continue
            }

            if ($line.StartsWith("export ")) {
                $line = $line.Substring(7).Trim()
            }

            $match = [regex]::Match($line, '^(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>.*)$')
            if (-not $match.Success) {
                continue
            }

            $name = $match.Groups["name"].Value
            $existingValue = [Environment]::GetEnvironmentVariable($name, "Process")
            if (-not [string]::IsNullOrWhiteSpace($existingValue)) {
                continue
            }

            $value = ConvertFrom-DotEnvValue -Value $match.Groups["value"].Value
            [Environment]::SetEnvironmentVariable($name, $value, "Process")
        }

        $loadedFiles += $path
    }

    return $loadedFiles
}

function Write-RequiredEnvironmentWarnings {
    param(
        [string[]]$VariableNames
    )

    foreach ($name in $VariableNames) {
        $value = [Environment]::GetEnvironmentVariable($name, "Process")
        if ([string]::IsNullOrWhiteSpace($value)) {
            Write-Host "[sophia] WARNING: $name not found in process env, .env, backend/.env, or voice/.env" -ForegroundColor Yellow
        }
    }
}

function Get-ServiceState {
    if (-not (Test-Path $STATE_FILE)) {
        return @()
    }

    try {
        $raw = Get-Content -Path $STATE_FILE -Raw -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($raw)) {
            return @()
        }

        $parsed = $raw | ConvertFrom-Json -ErrorAction Stop
        if ($parsed -is [System.Array]) {
            return $parsed
        }

        if ($null -ne $parsed) {
            return @($parsed)
        }
    } catch {
        Write-Host "[sophia] WARNING: Failed to parse $STATE_FILE. Ignoring stale state." -ForegroundColor Yellow
    }

    return @()
}

function Save-ServiceState {
    param(
        [array]$Services
    )

    $state = foreach ($service in $Services) {
        [pscustomobject]@{
            Name = $service.Name
            Port = $service.Port
            Pid = $service.Pid
            Log = $service.Log
        }
    }

    $state | ConvertTo-Json | Set-Content -Path $STATE_FILE -Encoding UTF8
}

function Remove-ServiceState {
    if (Test-Path $STATE_FILE) {
        Remove-Item -Path $STATE_FILE -Force -ErrorAction SilentlyContinue
    }
}

function Start-DetachedService {
    param(
        [string]$Name,
        [int]$Port,
        [string[]]$ScriptLines,
        [string]$LogPath
    )

    $script = @(
        '$ErrorActionPreference = ''Continue'''
        $ScriptLines
    ) -join "`r`n"

    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    $process = Start-Process -FilePath $PS_EXECUTABLE -ArgumentList @(
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        $encodedCommand
    ) -WorkingDirectory $ROOT -WindowStyle Hidden -PassThru

    return [pscustomobject]@{
        Name = $Name
        Port = $Port
        Pid = $process.Id
        Log = $LogPath
    }
}

function Wait-ForListeningPort {
    param(
        [int]$Port,
        [int]$TimeoutSeconds = 20
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $conn = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
                Where-Object State -eq 'Listen' |
                Select-Object -First 1
        if ($conn) {
            return $true
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    return $false
}

if ($Stop) {
    Stop-AllServices
    return
}

$repoEnvFiles = @(
    (Join-Path $ROOT ".env")
    (Join-Path (Join-Path $ROOT "backend") ".env")
    (Join-Path (Join-Path $ROOT "voice") ".env")
)
$loadedEnvFiles = Import-DotEnvFiles -Paths $repoEnvFiles
if ($loadedEnvFiles.Count -gt 0) {
    Write-Host ("[sophia] Loaded repo env files: " + (($loadedEnvFiles | ForEach-Object {
        if ($_.StartsWith($ROOT)) {
            $_.Substring($ROOT.Length).TrimStart([char[]]@(92, 47))
        } else {
            $_
        }
    }) -join ", ")) -ForegroundColor DarkGray
}
Write-RequiredEnvironmentWarnings -VariableNames @(
    "ANTHROPIC_API_KEY",
    "STREAM_API_KEY",
    "STREAM_API_SECRET"
)

New-Item -ItemType Directory -Path $LOG_DIR -Force | Out-Null
foreach ($logName in "langgraph", "gateway", "voice", "frontend") {
    $logPath = Join-Path $LOG_DIR "$logName.log"
    if (Test-Path $logPath) {
        Clear-Content -Path $logPath -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
# Pre-flight: kill anything on our ports
# ---------------------------------------------------------------------------
Stop-AllServices

# ---------------------------------------------------------------------------
# 1. LangGraph  (port 2024)
# ---------------------------------------------------------------------------
Write-Host "[sophia] Starting LangGraph on :2024 ..." -ForegroundColor Cyan
$lgLog = Join-Path $LOG_DIR "langgraph.log"
$backendDir = Join-Path $ROOT "backend"
$quotedBackendDir = ConvertTo-SingleQuotedPowerShellLiteral $backendDir
$quotedLgLog = ConvertTo-SingleQuotedPowerShellLiteral $lgLog
$lgProcess = Start-DetachedService -Name "LangGraph" -Port 2024 -LogPath $lgLog -ScriptLines @(
    "Set-Location $quotedBackendDir"
    '$jobsPerWorker = if ($env:N_JOBS_PER_WORKER) { $env:N_JOBS_PER_WORKER } else { "4" }'
    'if (-not $env:BG_JOB_ISOLATED_LOOPS) { $env:BG_JOB_ISOLATED_LOOPS = "true" }'
    "& uv run langgraph dev --no-browser --allow-blocking --no-reload --n-jobs-per-worker `$jobsPerWorker *>> $quotedLgLog"
)

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
$gwLog = Join-Path $LOG_DIR "gateway.log"
$quotedGwLog = ConvertTo-SingleQuotedPowerShellLiteral $gwLog
$gwProcess = Start-DetachedService -Name "Gateway" -Port 8001 -LogPath $gwLog -ScriptLines @(
    "Set-Location $quotedBackendDir"
    '$env:PYTHONPATH = "."'
    '$env:SOPHIA_AUTH_BACKEND_URL = "http://127.0.0.1:3000"'
    "& uv run uvicorn app.gateway.app:app --host 0.0.0.0 --port 8001 *>> $quotedGwLog"
)

# ---------------------------------------------------------------------------
# 3. Voice server  (port 8000)
# ---------------------------------------------------------------------------
Write-Host "[sophia] Starting Voice server on :8000 ..." -ForegroundColor Cyan
$voiceLog = Join-Path $LOG_DIR "voice.log"
$voicePython = Join-Path $ROOT "voice\.venv\Scripts\python.exe"
$quotedRoot = ConvertTo-SingleQuotedPowerShellLiteral $ROOT
$quotedVoicePython = ConvertTo-SingleQuotedPowerShellLiteral $voicePython
$quotedVoiceLog = ConvertTo-SingleQuotedPowerShellLiteral $voiceLog
$voiceProcess = Start-DetachedService -Name "Voice" -Port 8000 -LogPath $voiceLog -ScriptLines @(
    "Set-Location $quotedRoot"
    "& $quotedVoicePython -m voice.server serve --port 8000 *>> $quotedVoiceLog"
)

# ---------------------------------------------------------------------------
# 4. Frontend  (port 3000)
# ---------------------------------------------------------------------------
Write-Host "[sophia] Starting Frontend on :3000 ..." -ForegroundColor Cyan
$feLog = Join-Path $LOG_DIR "frontend.log"
$frontendDir = Join-Path $ROOT "frontend"
$quotedFrontendDir = ConvertTo-SingleQuotedPowerShellLiteral $frontendDir
$quotedFeLog = ConvertTo-SingleQuotedPowerShellLiteral $feLog
$feProcess = Start-DetachedService -Name "Frontend" -Port 3000 -LogPath $feLog -ScriptLines @(
    "Set-Location $quotedFrontendDir"
    '$env:PORT = "3000"'
    "& pnpm run dev *>> $quotedFeLog"
)

# ---------------------------------------------------------------------------
# Wait for all ports
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "========================================" -ForegroundColor White
Write-Host "  Sophia Services" -ForegroundColor White
Write-Host "========================================" -ForegroundColor White

$services = @(
    $lgProcess,
    $gwProcess,
    $voiceProcess,
    $feProcess
)

Save-ServiceState -Services $services

foreach ($svc in $services) {
    $ready = Wait-ForListeningPort -Port $svc.Port
    $process = Get-Process -Id $svc.Pid -ErrorAction SilentlyContinue
    if ($ready -and $process) {
        Write-Host "  [OK] $($svc.Name) -> http://localhost:$($svc.Port)" -ForegroundColor Green
    } else {
        Write-Host "  [!!] $($svc.Name) :$($svc.Port) - NOT READY (check: $($svc.Log))" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "Logs:" -ForegroundColor DarkGray
Write-Host "  Get-Content .\logs\langgraph.log -Wait" -ForegroundColor DarkGray
Write-Host "  Get-Content .\logs\gateway.log -Wait" -ForegroundColor DarkGray
Write-Host "  Get-Content .\logs\voice.log -Wait" -ForegroundColor DarkGray
Write-Host "  Get-Content .\logs\frontend.log -Wait" -ForegroundColor DarkGray
Write-Host "" 
Write-Host "Stop:" -ForegroundColor DarkGray
Write-Host "  .\scripts\start-all.ps1 -Stop" -ForegroundColor DarkGray
Write-Host ""
Write-Host "[sophia] Detached launcher finished. Services keep running in the background." -ForegroundColor Green
