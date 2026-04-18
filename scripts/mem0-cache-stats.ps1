param([int]$Days = 2)

$lg = Get-Content .\logs\langgraph.log -ErrorAction SilentlyContinue
if (-not $lg) { Write-Host "No langgraph.log"; exit 0 }

$voiceHits = ($lg | Select-String -Pattern 'voice recent-cache hit' -SimpleMatch).Count
$zeroms = ($lg | Select-String -Pattern '\(search: 0ms\)').Count
$skips = ($lg | Select-String -Pattern 'Mem0Memory\] skipped').Count
$lruHits = ($lg | Select-String -Pattern 'Mem0Cache\] HIT').Count
$lruMiss = ($lg | Select-String -Pattern 'Mem0Cache\] MISS').Count
$realInjected = ($lg | Select-String -Pattern 'memories injected \(search: \d+ms\)').Count

Write-Host ""
Write-Host "Mem0 cache effectiveness (full log history):" -ForegroundColor Cyan
Write-Host "  voice fast-cache HITs:   $voiceHits"
Write-Host "  LRU cache HITs:          $lruHits"
Write-Host "  LRU cache MISSes:        $lruMiss"
Write-Host "  'search: 0ms' events:    $zeroms"
Write-Host "  skipped (low-sig/etc):   $skips"
Write-Host "  injected (any):          $realInjected"
Write-Host ""

$total = $voiceHits + $lruMiss + $skips
if ($total -gt 0) {
    $hitPct = [math]::Round(($voiceHits + $lruHits) / $total * 100, 1)
    $skipPct = [math]::Round($skips / $total * 100, 1)
    $missPct = [math]::Round($lruMiss / $total * 100, 1)
    Write-Host "Distribution of Mem0 calls:" -ForegroundColor Cyan
    Write-Host "  Cache hits:     $hitPct% (free)"
    Write-Host "  Skipped:        $skipPct% (free)"
    Write-Host "  Real API call:  $missPct% (costs ~800ms)"
    Write-Host ""
    Write-Host "Potential savings: eliminating half the real API calls would save" -ForegroundColor Yellow
    $saved = [math]::Round($missPct * 0.5 * 8, 0)
    Write-Host "  ~$saved ms from avg TTFT across all turns"
}
