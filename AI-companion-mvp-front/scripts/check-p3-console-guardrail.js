const fs = require('node:fs')
const path = require('node:path')

const workspaceRoot = process.cwd()

const governedFiles = [
  'src/app/hooks/voice/useVoiceWebSocket.ts',
  'src/app/hooks/useVoiceLoop.ts',
  'src/app/session/useSessionMemoryActions.ts',
  'src/app/session/useSessionExitFlow.ts',
  'src/app/session/useSessionExitProtection.ts',
  'src/app/session/useSessionRetryHandlers.ts',
  'src/app/session/useSessionVoiceCommandSystem.ts',
  'src/app/hooks/voice/useAudioPlayback.ts',
]

const consolePattern = /\bconsole\.(log|warn|error|info|debug)\b/

const allowedConsolePatternsByFile = {
  'src/app/hooks/voice/useAudioPlayback.ts': [
    /console\.debug\("\[AudioPlayback\] AudioContext closed on unmount"\)/,
    /console\.debug\(`\[AudioPlayback\] ▶️ PLAY START! Chunk 1 \(\$\{numSamples\} samples, \$\{latency\.toFixed\(0\)\}ms since rec[e]?ived\)`\)/,
    /console\.debug\(`\[AudioPlayback\] 🔊 Chunk \$\{chunkIndex\} scheduled @ \$\{startTime\.toFixed\(3\)\}s`\)/,
    /console\.debug\(`\[AudioPlayback\] ✅ Done! \$\{totalChunksPlayedRef\.current\} chunks in \$\{totalTime\}s`\)/,
  ],
}

function scanFile(relativePath) {
  const filePath = path.join(workspaceRoot, relativePath)
  const source = fs.readFileSync(filePath, 'utf8')
  const lines = source.split(/\r?\n/)

  const allowed = allowedConsolePatternsByFile[relativePath] || []
  const violations = []

  lines.forEach((line, index) => {
    if (!consolePattern.test(line)) return

    const isAllowed = allowed.some((pattern) => pattern.test(line))
    if (!isAllowed) {
      violations.push({
        file: relativePath,
        line: index + 1,
        content: line.trim(),
      })
    }
  })

  return violations
}

function main() {
  const allViolations = governedFiles.flatMap(scanFile)

  if (allViolations.length === 0) {
    console.log('P3 console guardrail passed: no unapproved console usage in governed files.')
    process.exit(0)
  }

  console.error('P3 console guardrail failed. Unapproved console usage found:')
  for (const violation of allViolations) {
    console.error(`- ${violation.file}:${violation.line} -> ${violation.content}`)
  }
  process.exit(1)
}

main()
