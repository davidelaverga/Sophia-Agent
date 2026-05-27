[CmdletBinding()]
param(
    [string[]]$StagedPath,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$forbiddenPatterns = @(
    @{ Label = "**/recaps/*.json"; Regex = "(^|/)recaps/[^/]+\.json$" },
    @{ Label = "**/traces/*.json"; Regex = "(^|/)traces/[^/]+\.json$" },
    @{ Label = "**/sessions/*.json"; Regex = "(^|/)sessions/[^/]+\.json$" },
    @{ Label = "**/transcripts/*.json"; Regex = "(^|/)transcripts/[^/]+\.json$" },
    @{ Label = "users/**"; Regex = "^users/" },
    @{ Label = "backend/users/**"; Regex = "^backend/users/" },
    @{ Label = "logs/**"; Regex = "(^|/)logs/" },
    @{ Label = "*.log"; Regex = "\.log$" },
    @{ Label = ".env"; Regex = "^\.env$" },
    @{ Label = ".env.*"; Regex = "^\.env\." },
    @{ Label = "frontend/.env*"; Regex = "^frontend/\.env" },
    @{ Label = "backend/.env*"; Regex = "^backend/\.env" },
    @{ Label = "voice/.env*"; Regex = "^voice/\.env" },
    @{ Label = "voice/.venv/**"; Regex = "^voice/\.venv/" },
    @{ Label = "frontend/node_modules/**"; Regex = "^frontend/node_modules/" },
    @{ Label = ".worktrees/**"; Regex = "^\.worktrees/" }
)

function Normalize-GitPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $normalizedPath = $Path -replace "\\", "/"
    while ($normalizedPath.StartsWith("./")) {
        $normalizedPath = $normalizedPath.Substring(2)
    }

    return $normalizedPath
}

function Get-ForbiddenMatch {
    param([Parameter(Mandatory = $true)][string]$Path)

    foreach ($pattern in $forbiddenPatterns) {
        if ($Path -match $pattern.Regex) {
            return $pattern.Label
        }
    }

    return $null
}

if ($PSBoundParameters.ContainsKey("StagedPath") -or $PSBoundParameters.ContainsKey("RemainingPath")) {
    $stagedFiles = @($StagedPath) + @($RemainingPath)
}
else {
    $stagedFiles = & git diff --cached --name-only
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Unable to read staged files with git diff --cached --name-only."
        exit 2
    }
}

$normalizedStagedFiles = @(
    $stagedFiles |
        Where-Object { $null -ne $_ -and $_.Trim() -ne "" } |
        ForEach-Object { Normalize-GitPath $_ }
)

if ($normalizedStagedFiles.Count -eq 0) {
    Write-Host "No staged files. Runtime artifact guard passed."
    exit 0
}

$blockedFiles = @(
    foreach ($path in $normalizedStagedFiles) {
        $matchedPattern = Get-ForbiddenMatch $path
        if ($null -ne $matchedPattern) {
            [PSCustomObject]@{
                Path = $path
                Pattern = $matchedPattern
            }
        }
    }
)

if ($blockedFiles.Count -eq 0) {
    Write-Host "No staged runtime artifacts found."
    exit 0
}

Write-Host "Staged local runtime artifacts were found. This guard does not delete or modify files."
Write-Host "Unstage these paths, move intentional fixtures outside runtime output folders, or update the guard with review."
Write-Host ""
Write-Host "Blocked staged paths:"

foreach ($blocked in $blockedFiles) {
    Write-Host (" - {0}  (matched {1})" -f $blocked.Path, $blocked.Pattern)
}

exit 1
