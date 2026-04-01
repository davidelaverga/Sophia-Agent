param(
  [string]$FrontendBaseUrl = 'http://localhost:3000',
  [string]$BackendBaseUrl = 'http://localhost:8000',
  [string]$SessionId = '123e4567-e89b-12d3-a456-426614174000',
  [string]$UserId = 'terminal-auth-check'
)

$ErrorActionPreference = 'Stop'

$Token = $env:SOPHIA_BACKEND_TOKEN

if ([string]::IsNullOrWhiteSpace($Token)) {
  Write-Error 'Missing token. Set SOPHIA_BACKEND_TOKEN environment variable.'
}

$body = @{
  message = 'smoke stream auth check'
  session_id = $SessionId
  user_id = $UserId
} | ConvertTo-Json

Write-Host '1) Backend authenticated stream check...'
$backendResp = Invoke-WebRequest `
  -Uri "$BackendBaseUrl/api/v1/chat/text/stream" `
  -Method POST `
  -ContentType 'application/json' `
  -Headers @{ Accept = 'text/event-stream'; Authorization = "Bearer $Token" } `
  -Body $body `
  -TimeoutSec 30

$backendOk =
  $backendResp.StatusCode -eq 200 -and
  $backendResp.Content.Contains('event: token') -and
  ($backendResp.Content.Contains('event: artifacts_complete') -or $backendResp.Content.Contains('event:artifacts_complete')) -and
  ($backendResp.Content.Contains('event: done') -or $backendResp.Content.Contains('event:done'))

if (-not $backendOk) {
  Write-Error 'Backend stream contract check failed.'
}

Write-Host '2) Frontend proxy data-stream check...'
$frontendResp = Invoke-WebRequest `
  -Uri "$FrontendBaseUrl/api/chat" `
  -Method POST `
  -ContentType 'application/json' `
  -Headers @{ 'x-sophia-stream-protocol' = 'data'; Cookie = "sophia-backend-token=$Token" } `
  -Body $body `
  -TimeoutSec 30

$frontOk =
  $frontendResp.StatusCode -eq 200 -and
  (($frontendResp.Headers['Content-Type'] -join ';') -match 'text/event-stream') -and
  ($frontendResp.Headers['x-vercel-ai-ui-message-stream'] -contains 'v1') -and
  $frontendResp.Content.Contains('"type":"data-artifactsV1"') -and
  $frontendResp.Content.Contains('"type":"data-sophia_meta"') -and
  $frontendResp.Content.Contains('data: [DONE]') -and
  -not $frontendResp.Content.Contains('event: token')

if (-not $frontOk) {
  Write-Error 'Frontend proxy data-stream contract check failed.'
}

Write-Host '✅ Smoke stream auth check passed.'
