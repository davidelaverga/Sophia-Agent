import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(testDirectory, '../../..');
const repoRoot = path.resolve(appRoot, '..');

function readAppFile(relativePath: string) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8');
}

function repoPathExists(relativePath: string) {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

function repoDirectoryContainsFiles(relativePath: string): boolean {
  const absolutePath = path.join(repoRoot, relativePath);

  if (!fs.existsSync(absolutePath)) {
    return false;
  }

  const entries = fs.readdirSync(absolutePath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile()) {
      return true;
    }

    if (entry.isDirectory() && repoDirectoryContainsFiles(path.join(relativePath, entry.name))) {
      return true;
    }
  }

  return false;
}

function expectFileToInclude(source: string, required: string[]) {
  for (const token of required) {
    expect(source).toContain(token);
  }
}

function expectFileToExclude(source: string, forbidden: string[]) {
  for (const token of forbidden) {
    expect(source).not.toContain(token);
  }
}

describe('runtime ownership contract', () => {
  it('keeps /chat as a thin route shell over the chat route experience', () => {
    const source = readAppFile('src/app/chat/page.tsx');

    expectFileToInclude(source, ['useChatRouteExperience', 'ConversationView']);
    expectFileToExclude(source, [
      'useCompanionRuntime',
      'useCompanionChatRuntime',
      'useCompanionStreamContract',
      'useCompanionArtifactsRuntime',
      'useCompanionVoiceRuntime',
      'useChatAiRuntime',
      'useStreamVoiceSession',
      'useInterrupt',
    ]);
  });

  it('keeps /session wired through the session route experience instead of deleted runtime owners', () => {
    const source = readAppFile('src/app/session/page.tsx');

    expectFileToInclude(source, ['useSessionRouteExperience']);
    expectFileToExclude(source, [
      'useSessionChatRuntime',
      'useSessionStreamContract',
      'useSessionArtifactsReducer',
      'useSessionVoiceBridge',
      'useSessionVoiceOrchestration',
      'useCompanionChatRuntime',
      'useCompanionStreamContract',
      'useCompanionArtifactsRuntime',
      'useCompanionVoiceRuntime',
    ]);
  });

  it('keeps conversation runtime ownership in the canonical companion runtime namespace', () => {
    const chatRouteSource = readAppFile('src/app/chat/useChatRouteExperience.ts');
    const sessionRouteSource = readAppFile('src/app/session/useSessionRouteExperience.ts');

    expectFileToInclude(chatRouteSource, ['useCompanionRuntime']);
    expectFileToExclude(chatRouteSource, ['useChatAiRuntime']);

    expectFileToInclude(sessionRouteSource, [
      'useCompanionArtifactsRuntime',
      'useCompanionChatRuntime',
      'useCompanionStreamContract',
      'useCompanionVoiceRuntime',
    ]);
    expectFileToExclude(sessionRouteSource, [
      'useSessionChatRuntime',
      'useSessionStreamContract',
      'useSessionArtifactsReducer',
      'useSessionVoiceBridge',
    ]);
  });

  it('keeps ConversationView presentation-only', () => {
    const source = readAppFile('src/app/components/ConversationView.tsx');

    expectFileToInclude(source, ['ChatRouteExperience']);
    expectFileToExclude(source, [
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
    ]);
  });

  it('keeps forbidden duplicate Sophia surfaces absent from the repo', () => {
    const forbiddenDirectoriesWithFiles = [
      'frontend/src/core/sophia',
      'frontend/src/app/mock/api/sophia',
    ];

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
    ];

    for (const forbiddenDirectory of forbiddenDirectoriesWithFiles) {
      expect(repoDirectoryContainsFiles(forbiddenDirectory)).toBe(false);
    }

    for (const forbiddenPath of forbiddenPaths) {
      expect(repoPathExists(forbiddenPath)).toBe(false);
    }
  });
});