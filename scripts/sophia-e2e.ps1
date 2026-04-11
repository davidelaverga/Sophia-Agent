<#
.SYNOPSIS
    Start Sophia end-to-end on Windows.

.DESCRIPTION
    Prepares the local environment for real DeerFlow-backed Sophia and then
    launches LangGraph, Gateway, Voice Server, and Frontend via sophia-dev.ps1.

    This script is intended for local Windows development where `make dev`
    is not the right entrypoint.

.EXAMPLE
    .\scripts\sophia-e2e.ps1

.EXAMPLE
    .\scripts\sophia-e2e.ps1 -UserId jorge_test

.EXAMPLE
    .\scripts\sophia-e2e.ps1 -Stop
#>

param(
    [string]$UserId = "dev-user",
    [switch]$NoAuthBypass,
    [switch]$Stop
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$RootEnvPath = Join-Path $RepoRoot ".env"
$VoiceEnvPath = Join-Path $RepoRoot "voice\.env"
$FrontendEnvPath = Join-Path $RepoRoot "frontend\.env"
$ConfigPath = Join-Path $RepoRoot "config.yaml"
$VoicePython = Join-Path $RepoRoot "voice\.venv\Scripts\python.exe"
$LauncherPath = Join-Path $PSScriptRoot "sophia-dev.ps1"
$StopHelperPath = Join-Path $PSScriptRoot "start-all.ps1"

function Get-DotEnvValue {
    param(
        [string]$Name,
        [string[]]$Files
    )

    $processValue = [Environment]::GetEnvironmentVariable($Name)
    if (-not [string]::IsNullOrWhiteSpace($processValue)) {
        return $processValue.Trim()
    }

    foreach ($file in $Files) {
        if (-not (Test-Path $file)) {
            continue
        }

        foreach ($line in Get-Content -Path $file) {
            if ($line -match '^\s*#' -or $line -match '^\s*$') {
                continue
            }

            if ($line -match "^\s*$([Regex]::Escape($Name))\s*=\s*(.*)\s*$") {
                $value = $Matches[1].Trim()
                if (
                    ($value.StartsWith('"') -and $value.EndsWith('"')) -or
                    ($value.StartsWith("'") -and $value.EndsWith("'"))
                ) {
                    $value = $value.Substring(1, $value.Length - 2)
                }

                if (-not [string]::IsNullOrWhiteSpace($value)) {
                    return $value
                }
            }
        }
    }

    return $null
}

function Assert-PathExists {
    param(
        [string]$Path,
        [string]$HelpMessage
    )

    if (-not (Test-Path $Path)) {
        throw "$HelpMessage`nMissing path: $Path"
    }
}

function Assert-EnvAvailable {
    param(
        [string]$Name,
        [string[]]$Files,
        [string]$Purpose
    )

    $value = Get-DotEnvValue -Name $Name -Files $Files
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "Missing required setting '$Name' for $Purpose. Add it to your environment, $RootEnvPath, or $VoiceEnvPath."
    }

    return $value
}

if ($Stop) {
    if (Test-Path $StopHelperPath) {
        & $StopHelperPath -Stop
        exit $LASTEXITCODE
    }

    throw "Stop helper not found at $StopHelperPath"
}

Assert-PathExists -Path $LauncherPath -HelpMessage "The base Sophia launcher was not found."
Assert-PathExists -Path $ConfigPath -HelpMessage "Sophia requires config.yaml. Run python .\\scripts\\configure.py first."
Assert-PathExists -Path $RootEnvPath -HelpMessage "Sophia requires a root .env file. Run python .\\scripts\\configure.py first."
Assert-PathExists -Path $FrontendEnvPath -HelpMessage "Sophia requires frontend/.env. Run python .\\scripts\\configure.py first."
Assert-PathExists -Path $VoicePython -HelpMessage "Voice virtual environment is missing. Install it with voice\\.venv\\Scripts\\python.exe -m pip install -r voice\\requirements.txt."

$requiredVoiceVars = @(
    @{ Name = "STREAM_API_KEY"; Purpose = "Stream call transport" }
    @{ Name = "STREAM_API_SECRET"; Purpose = "Stream token generation" }
    @{ Name = "DEEPGRAM_API_KEY"; Purpose = "speech-to-text" }
    @{ Name = "CARTESIA_API_KEY"; Purpose = "text-to-speech" }
)

foreach ($required in $requiredVoiceVars) {
    Assert-EnvAvailable -Name $required.Name -Files @($RootEnvPath, $VoiceEnvPath) -Purpose $required.Purpose | Out-Null
}

$betterAuthSecret = Get-DotEnvValue -Name "BETTER_AUTH_SECRET" -Files @($FrontendEnvPath)
if ([string]::IsNullOrWhiteSpace($betterAuthSecret)) {
    $betterAuthSecret = "local-dev-secret"
}

$betterAuthUrl = Get-DotEnvValue -Name "BETTER_AUTH_URL" -Files @($FrontendEnvPath)
if ([string]::IsNullOrWhiteSpace($betterAuthUrl)) {
    $betterAuthUrl = "http://localhost:3000"
}

$env:DEER_FLOW_CONFIG_PATH = $ConfigPath
$env:SOPHIA_BACKEND_MODE = "deerflow"
$env:SOPHIA_LANGGRAPH_BASE_URL = "http://127.0.0.1:2024"
$env:SOPHIA_ASSISTANT_ID = "sophia_companion"
$env:SOPHIA_AUTH_BACKEND_URL = "http://127.0.0.1:3000"
$env:VOICE_SERVER_URL = "http://127.0.0.1:8000"
$env:BETTER_AUTH_SECRET = $betterAuthSecret
$env:BETTER_AUTH_URL = $betterAuthUrl
$env:NEXT_PUBLIC_GATEWAY_URL = "http://127.0.0.1:8001"
$env:NEXT_PUBLIC_SOPHIA_USER_ID = $UserId

if (-not $NoAuthBypass) {
    $env:NEXT_PUBLIC_DEV_BYPASS_AUTH = "true"
}

Write-Host "" 
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Sophia End-to-End Launcher (Windows)" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "" 
Write-Host "  Backend mode: deerflow" -ForegroundColor White
Write-Host "  LangGraph:    $($env:SOPHIA_LANGGRAPH_BASE_URL)" -ForegroundColor White
Write-Host "  Gateway:      $($env:NEXT_PUBLIC_GATEWAY_URL)" -ForegroundColor White
Write-Host "  Voice:        $($env:VOICE_SERVER_URL)" -ForegroundColor White
Write-Host "  Auth bridge:  $($env:SOPHIA_AUTH_BACKEND_URL)" -ForegroundColor White
Write-Host "  User ID:      $UserId" -ForegroundColor White
Write-Host "  Auth bypass:  $([string](-not $NoAuthBypass).ToString().ToLower())" -ForegroundColor White
Write-Host "" 
Write-Host "  Starting LangGraph + Gateway + Voice + Frontend..." -ForegroundColor DarkGray
Write-Host "" 

& $LauncherPath
exit $LASTEXITCODE