# Correlates voice.log turn timings with langgraph.log middleware timings.
# Reads recent turns and prints a per-turn breakdown:
#   request_to_first_text | request_to_artifact | mem0 | llm | prompt_chars | blocks
#
# Usage:
#   .\scripts\voice-perf.ps1              # last 15 turns
#   .\scripts\voice-perf.ps1 -Turns 30    # last 30
#   .\scripts\voice-perf.ps1 -Since "2026-04-18T03:20"
[CmdletBinding()]
param(
    $Turns = 15,
    $Since = $null
)

$ErrorActionPreference = "Stop"
$TurnsInt = [int]$Turns

$repoRoot = Split-Path -Parent $PSScriptRoot
$voiceLog = Join-Path $repoRoot "logs\voice.log"
$lgLog = Join-Path $repoRoot "logs\langgraph.log"

if (-not (Test-Path $voiceLog)) { throw "voice.log not found at $voiceLog" }
if (-not (Test-Path $lgLog))   { throw "langgraph.log not found at $lgLog" }

# ---------- Parse voice.log TURN_BREAKDOWN entries ----------
# Example line:
# 2026-04-17 23:24:54,123 [VOICE:LLM] TURN_BREAKDOWN | user_id=xxx | request_to_first_text_ms=1234 | request_to_artifact_ms=5432 | chunks=6
$voiceTurns = @()
$tbPattern = '(?<ts>\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}).*TURN_BREAKDOWN.*request_to_first_text_ms=(?<ttft>\d+).*request_to_artifact_ms=(?<tta>\d+)'
foreach ($line in (Get-Content $voiceLog -ErrorAction SilentlyContinue)) {
    $m = [regex]::Match($line, $tbPattern)
    if ($m.Success) {
        $voiceTurns += [PSCustomObject]@{
            Timestamp = [datetime]::Parse($m.Groups['ts'].Value.Replace(' ', 'T'))
            FirstTextMs = [int]$m.Groups['ttft'].Value
            ArtifactMs  = [int]$m.Groups['tta'].Value
        }
    }
}

# ---------- Parse langgraph.log middleware entries, grouping by request_id ----------
# Fields we care about per request_id:
#   Mem0 search_ms (from "[Mem0Memory] ... (search: NNNms)" or "skipped ..." )
#   PromptAssembly blocks + chars  (from "[PromptAssembly] N blocks assembled (Mchars chars)")
#   LLM ms                          (from "[LLM] model call completed (Nms)")
#   first timestamp
$requests = @{}

function _Get-OrCreate($map, $key) {
    if (-not $map.ContainsKey($key)) {
        $map[$key] = [PSCustomObject]@{
            RequestId = $key
            FirstTs = $null
            Mem0Ms = $null
            Mem0Skip = $null
            PromptBlocks = $null
            PromptChars = $null
            LLMMs = $null
            Ritual = $null
            Skill = $null
            ContextMode = $null
        }
    }
    return $map[$key]
}

$lgContent = Get-Content $lgLog -ErrorAction SilentlyContinue
foreach ($line in $lgContent) {
    $reqMatch = [regex]::Match($line, 'request_id=(?<rid>[a-f0-9\-]+)')
    if (-not $reqMatch.Success) { continue }
    $rid = $reqMatch.Groups['rid'].Value
    $tsMatch = [regex]::Match($line, '^(?<ts>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})')
    $entry = _Get-OrCreate $requests $rid
    if ($tsMatch.Success -and -not $entry.FirstTs) {
        $entry.FirstTs = [datetime]::Parse($tsMatch.Groups['ts'].Value)
    }

    # Mem0 timing
    $m = [regex]::Match($line, '\[Mem0Memory\] \d+ memories injected \(search: (?<ms>\d+)ms\)')
    if ($m.Success) { $entry.Mem0Ms = [int]$m.Groups['ms'].Value }
    $m2 = [regex]::Match($line, '\[Mem0Memory\] skipped \((?<reason>[^\)]+)\)')
    if ($m2.Success) { $entry.Mem0Skip = $m2.Groups['reason'].Value; if ($null -eq $entry.Mem0Ms) { $entry.Mem0Ms = 0 } }
    $m3 = [regex]::Match($line, '\[Mem0Memory\] no memories found \(search: (?<ms>\d+)ms\)')
    if ($m3.Success) { $entry.Mem0Ms = [int]$m3.Groups['ms'].Value }

    # Prompt assembly
    $p = [regex]::Match($line, '\[PromptAssembly\] (?<blocks>\d+) blocks assembled \((?<chars>\d+) chars\)')
    if ($p.Success) {
        $entry.PromptBlocks = [int]$p.Groups['blocks'].Value
        $entry.PromptChars = [int]$p.Groups['chars'].Value
    }

    # LLM
    $l = [regex]::Match($line, '\[LLM\] model call completed \((?<ms>\d+)ms\)')
    if ($l.Success) { $entry.LLMMs = [int]$l.Groups['ms'].Value }

    # Context
    $ctx = [regex]::Match($line, 'context_mode=(?<cm>[a-z_]+).*ritual=(?<r>[a-z_]+).*skill=(?<s>[a-z_]+)')
    if ($ctx.Success) {
        $entry.ContextMode = $ctx.Groups['cm'].Value
        $entry.Ritual = $ctx.Groups['r'].Value
        $entry.Skill = $ctx.Groups['s'].Value
    }
}

$turns = $requests.Values | Where-Object { $_.LLMMs -ne $null } | Sort-Object FirstTs

if ($Since) {
    $sinceDt = [datetime]::Parse($Since)
    $turns = $turns | Where-Object { $_.FirstTs -ge $sinceDt }
}

$turns = $turns | Select-Object -Last $TurnsInt

if ($turns.Count -eq 0) { Write-Host "No matching LangGraph turns found."; exit 0 }

# ---------- Render table ----------
Write-Host ""
Write-Host "Per-turn backend breakdown (last $($turns.Count) turns):" -ForegroundColor Cyan
Write-Host ""

$fmt = "{0,-19}  {1,7}  {2,8}  {3,7}  {4,6}  {5,-10}  {6,-18}  {7,-8}"
Write-Host ($fmt -f "time", "mem0ms", "prompt", "llm_ms", "blocks", "mem0", "skill", "ritual") -ForegroundColor Yellow
Write-Host ("-" * 95)

foreach ($t in $turns) {
    $mem0Label = if ($t.Mem0Skip) { "skip:" + $t.Mem0Skip.Substring(0, [Math]::Min(8, $t.Mem0Skip.Length)) } else { "hit" }
    $prompt = if ($t.PromptChars) { "$([int]($t.PromptChars/1000))k" } else { "-" }
    $llmColor = "Gray"
    if ($t.LLMMs -gt 7000) { $llmColor = "Red" }
    elseif ($t.LLMMs -gt 4500) { $llmColor = "Yellow" }
    else { $llmColor = "Green" }
    $timeStr = $t.FirstTs.ToString("HH:mm:ss")
    $skillVal = if ($t.Skill) { $t.Skill } else { "-" }
    $ritualVal = if ($t.Ritual) { $t.Ritual } else { "-" }
    $line = $fmt -f $timeStr, ($t.Mem0Ms), $prompt, $t.LLMMs, $t.PromptBlocks, $mem0Label, $skillVal, $ritualVal
    Write-Host $line -ForegroundColor $llmColor
}

# ---------- Summary stats ----------
Write-Host ""
Write-Host "Summary (ms):" -ForegroundColor Cyan
$mem0Nonzero = $turns | Where-Object { $_.Mem0Ms -gt 0 } | Select-Object -ExpandProperty Mem0Ms
$mem0Skips = ($turns | Where-Object { $_.Mem0Skip }).Count
$llms = $turns | Select-Object -ExpandProperty LLMMs
if ($mem0Nonzero.Count -gt 0) {
    $mem0Avg = [int](($mem0Nonzero | Measure-Object -Average).Average)
    $mem0Max = ($mem0Nonzero | Measure-Object -Maximum).Maximum
    Write-Host ("  Mem0 (miss path):  avg={0}ms  max={1}ms  hits/skips={2}/{3}" -f $mem0Avg, $mem0Max, ($turns.Count - $mem0Nonzero.Count - $mem0Skips), $mem0Skips)
} else {
    Write-Host "  Mem0: all cache hits or skipped"
}
$llmAvg = [int](($llms | Measure-Object -Average).Average)
$llmMax = ($llms | Measure-Object -Maximum).Maximum
$llmMin = ($llms | Measure-Object -Minimum).Minimum
Write-Host ("  LLM:              avg={0}ms  min={1}ms  max={2}ms" -f $llmAvg, $llmMin, $llmMax)

# Voice-side correlation (by nearest timestamp)
if ($voiceTurns.Count -gt 0) {
    Write-Host ""
    Write-Host "Voice side (last $($voiceTurns.Count) TURN_BREAKDOWN entries):" -ForegroundColor Cyan
    $voiceRecent = $voiceTurns | Select-Object -Last 10
    $ttfts = $voiceRecent | Select-Object -ExpandProperty FirstTextMs
    $ttas = $voiceRecent | Select-Object -ExpandProperty ArtifactMs
    Write-Host ("  request_to_first_text:  avg={0}ms  min={1}ms  max={2}ms" -f `
        [int](($ttfts | Measure-Object -Average).Average), `
        ($ttfts | Measure-Object -Minimum).Minimum, `
        ($ttfts | Measure-Object -Maximum).Maximum)
    Write-Host ("  request_to_artifact:    avg={0}ms  min={1}ms  max={2}ms" -f `
        [int](($ttas | Measure-Object -Average).Average), `
        ($ttas | Measure-Object -Minimum).Minimum, `
        ($ttas | Measure-Object -Maximum).Maximum)
}

Write-Host ""
