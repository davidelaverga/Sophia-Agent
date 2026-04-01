const fs = require('node:fs')
const path = require('node:path')

const workspaceRoot = process.cwd()
const sourceRoot = path.join(workspaceRoot, 'src', 'app')

const consolePattern = /\bconsole\.(log|warn|error|info|debug)\b/

const allowlistedFiles = new Set([
  'src/app/lib/debug-logger.ts',
])

const ignoredDirs = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
])

const allowedExtensions = new Set(['.ts', '.tsx', '.js', '.jsx'])

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/')
}

function shouldScanFile(relativePath) {
  const ext = path.extname(relativePath)
  if (!allowedExtensions.has(ext)) return false
  if (relativePath.endsWith('.d.ts')) return false
  return !allowlistedFiles.has(toPosix(relativePath))
}

function walkDir(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const absolute = path.join(dirPath, entry.name)

    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) continue
      files.push(...walkDir(absolute))
      continue
    }

    const relative = path.relative(workspaceRoot, absolute)
    if (shouldScanFile(relative)) {
      files.push({ absolute, relative: toPosix(relative) })
    }
  }

  return files
}

function scanFile(file) {
  const source = fs.readFileSync(file.absolute, 'utf8')
  const lines = source.split(/\r?\n/)
  const violations = []

  lines.forEach((line, index) => {
    if (!consolePattern.test(line)) return
    violations.push({
      file: file.relative,
      line: index + 1,
      content: line.trim(),
    })
  })

  return violations
}

function main() {
  if (!fs.existsSync(sourceRoot)) {
    console.error('Global console guardrail failed: src/app directory not found.')
    process.exit(1)
  }

  const files = walkDir(sourceRoot)
  const violations = files.flatMap(scanFile)

  if (violations.length === 0) {
    console.log('Global console guardrail passed: no unapproved console usage under src/app.')
    process.exit(0)
  }

  console.error('Global console guardrail failed. Unapproved console usage found:')
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line} -> ${violation.content}`)
  }
  process.exit(1)
}

main()
