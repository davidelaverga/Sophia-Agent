# start-sophia.ps1 — Start all Sophia services in separate terminals
# Usage: .\start-sophia.ps1
# Stop:  Close all terminals, or press Ctrl+C in each

$root = $PSScriptRoot

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Starting Sophia MVP (4 services)"      -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  1. LangGraph Backend  :2024" -ForegroundColor Green
Write-Host "  2. Gateway API        :8001" -ForegroundColor Green
Write-Host "  3. Voice Server       :8000" -ForegroundColor Green
Write-Host "  4. Frontend (Next.js) :3000" -ForegroundColor Green
Write-Host ""

# Terminal 1: LangGraph Backend
Start-Process powershell -ArgumentList "-NoExit", "-Command", @"
    Set-Location '$root\backend'
    Write-Host '=== LangGraph Backend :2024 ===' -ForegroundColor Yellow
    make dev
"@

# Wait for LangGraph to start before voice server
Write-Host "Waiting 5s for LangGraph to start..." -ForegroundColor DarkGray
Start-Sleep -Seconds 5

# Terminal 2: Gateway API
Start-Process powershell -ArgumentList "-NoExit", "-Command", @"
    Set-Location '$root\backend'
    Write-Host '=== Gateway API :8001 ===' -ForegroundColor Yellow
    `$env:PYTHONPATH = '.'
    uv run uvicorn app.gateway.app:app --host 0.0.0.0 --port 8001
"@

# Terminal 3: Voice Server
Start-Process powershell -ArgumentList "-NoExit", "-Command", @"
    Set-Location '$root'
    Write-Host '=== Voice Server :8000 ===' -ForegroundColor Yellow
    voice\.venv\Scripts\python.exe -m voice.server serve --port 8000
"@

# Terminal 4: Frontend
Start-Process powershell -ArgumentList "-NoExit", "-Command", @"
    Set-Location '$root\frontend'
    Write-Host '=== Frontend :3000 ===' -ForegroundColor Yellow
    pnpm dev
"@

Write-Host ""
Write-Host "All services starting in separate terminals." -ForegroundColor Green
Write-Host "Frontend: http://localhost:3000" -ForegroundColor Cyan
Write-Host "Gateway:  http://localhost:8001/docs" -ForegroundColor Cyan
Write-Host ""
Write-Host "Close all terminals to stop everything." -ForegroundColor DarkGray
