const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..')

const forbiddenDirectoriesWithFiles = [
  'frontend/src/core/sophia',
  'frontend/src/app/mock/api/sophia',
]

const forbiddenPaths = [
  'frontend/src/components/workspace/settings/sophia-memory-candidates-section.tsx',
  'frontend/src/components/workspace/settings/sophia-memory-candidate-card.tsx',
  'frontend/src/components/workspace/settings/sophia-memory-candidate-form.tsx',
  'AI-companion-mvp-front/src/app/chat/useChatAiRuntime.ts',
  'AI-companion-mvp-front/src/app/session/useSessionChatRuntime.ts',
  'AI-companion-mvp-front/src/app/session/useSessionStreamContract.ts',
  'AI-companion-mvp-front/src/app/session/useSessionArtifactsReducer.ts',
  'AI-companion-mvp-front/src/app/session/useSessionVoiceBridge.ts',
  'AI-companion-mvp-front/src/app/components/StreamVoiceProvider.tsx',
]

const routeContracts = [
  {
    file: 'AI-companion-mvp-front/src/app/chat/page.tsx',
    required: ['useChatRouteExperience'],
    forbidden: [
      'useCompanionRuntime',
      'useCompanionChatRuntime',
      'useCompanionStreamContract',
      'useCompanionArtifactsRuntime',
      'useCompanionVoiceRuntime',
      'useChatAiRuntime',
      'useStreamVoiceSession',
      'useInterrupt',
    ],
  },
  {
    file: 'AI-companion-mvp-front/src/app/session/page.tsx',
    required: ['useSessionRouteExperience'],
    forbidden: [
      'useSessionChatRuntime',
      'useSessionStreamContract',
      'useSessionArtifactsReducer',
      'useSessionVoiceBridge',
      'useSessionVoiceOrchestration',
      'useCompanionChatRuntime',
      'useCompanionStreamContract',
      'useCompanionArtifactsRuntime',
      'useCompanionVoiceRuntime',
    ],
  },
  {
    file: 'AI-companion-mvp-front/src/app/components/ConversationView.tsx',
    required: ['ChatRouteExperience'],
    forbidden: [
      'useCompanionRuntime',
      'useCompanionChatRuntime',
      'useCompanionStreamContract',
      'useCompanionArtifactsRuntime',
      'useCompanionVoiceRuntime',
      'useChatAiRuntime',
      'useStreamVoiceSession',
      'useInterrupt',
      'useSessionPersistence',
      'useBackendTokenSync',
      'useUsageMonitor',
    ],
  },
  {
    file: 'AI-companion-mvp-front/src/app/chat/useChatRouteExperience.ts',
    required: ['useCompanionRuntime'],
    forbidden: ['useChatAiRuntime'],
  },
  {
    file: 'AI-companion-mvp-front/src/app/session/useSessionRouteExperience.ts',
    required: [
      'useCompanionArtifactsRuntime',
      'useCompanionChatRuntime',
      'useCompanionStreamContract',
      'useCompanionVoiceRuntime',
    ],
    forbidden: [
      'useSessionChatRuntime',
      'useSessionStreamContract',
      'useSessionArtifactsReducer',
      'useSessionVoiceBridge',
    ],
  },
]

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function directoryContainsFiles(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath)

  if (!fs.existsSync(absolutePath)) {
    return false
  }

  const entries = fs.readdirSync(absolutePath, { withFileTypes: true })

  for (const entry of entries) {
    if (entry.isFile()) {
      return true
    }

    if (entry.isDirectory() && directoryContainsFiles(path.join(relativePath, entry.name))) {
      return true
    }
  }

  return false
}

function main() {
  const failures = []

  for (const relativePath of forbiddenDirectoriesWithFiles) {
    if (directoryContainsFiles(relativePath)) {
      failures.push(`Forbidden directory contains files: ${relativePath}`)
    }
  }

  for (const relativePath of forbiddenPaths) {
    if (fs.existsSync(path.join(repoRoot, relativePath))) {
      failures.push(`Forbidden path present: ${relativePath}`)
    }
  }

  for (const contract of routeContracts) {
    const absolutePath = path.join(repoRoot, contract.file)

    if (!fs.existsSync(absolutePath)) {
      failures.push(`Contract file missing: ${contract.file}`)
      continue
    }

    const source = read(contract.file)

    for (const token of contract.required) {
      if (!source.includes(token)) {
        failures.push(`${contract.file} must include ${token}`)
      }
    }

    for (const token of contract.forbidden) {
      if (source.includes(token)) {
        failures.push(`${contract.file} must not include ${token}`)
      }
    }
  }

  if (failures.length > 0) {
    console.error('Sophia surface boundary guardrail failed:')
    for (const failure of failures) {
      console.error(`- ${failure}`)
    }
    process.exit(1)
  }

  console.log('Sophia surface boundary guardrail passed.')
}

main()