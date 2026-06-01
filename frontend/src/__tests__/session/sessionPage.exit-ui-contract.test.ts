import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(testDirectory, '../..');

function readAppFile(relativePath: string) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8');
}

describe('session page exit UI contract', () => {
  it('renders the debrief-offer UI when exit orchestration exposes that state', () => {
    const source = readAppFile('app/session/page.tsx');

    expect(source).toContain('DebriefOfferModal');
    expect(source).toContain('showDebriefOffer');
    expect(source).toContain('debriefData');
    expect(source).toContain('handleStartDebrief');
    expect(source).toContain('handleSkipToRecap');
  });

  it('wires the session mode toggle to the embedded insight indicator instead of the standalone pill', () => {
    const source = readAppFile('app/session/page.tsx');

    expect(source).toContain('showInsightIndicator={hasArtifactsContent || hasNewArtifacts}');
    expect(source).toContain('hasNewInsight={hasNewArtifacts}');
    expect(source).toContain('onInsightClick={handleOpenArtifactsPanel}');
    expect(source).not.toContain('<ArtifactToggleIcon');
  });

  it('mounts the Coreview fixture launcher directly in the /session root', () => {
    const source = readAppFile('app/session/page.tsx');

    expect(source).toContain('<CoreviewFixtureLauncher');
    expect(source).toContain('isVisible={coReviewFixtureEnabled}');
    expect(source).toContain('coReviewTransport={coReviewTransport}');
  });

  it('allows artifact-library recovery after a builder task has reached a terminal phase', () => {
    const source = readAppFile('app/session/page.tsx');

    expect(source).toContain("const isBuilderActivelyRunning = builderTask?.phase === 'running';");
    expect(source).toContain('!isBuilderActivelyRunning ? builderArtifactLibrary[0] : null');
    expect(source).not.toContain('!builderTask ? builderArtifactLibrary[0] : null');
  });

  it('matches backend missing-deliverable text before artifact-library recovery', () => {
    const source = readAppFile('app/session/page.tsx');

    expect(source).toContain("const MISSING_BUILDER_DELIVERABLE_ERROR = 'Builder finished without a deliverable artifact.';");
    expect(source).toContain('builderCompletion.error_message === MISSING_BUILDER_DELIVERABLE_ERROR');
    expect(source).toContain('MISSING_BUILDER_DELIVERABLE_RETRY_MESSAGE');
  });

  it('does not recover a failed completion from stale persisted builder artifacts', () => {
    const source = readAppFile('app/session/page.tsx');

    expect(source).toContain('const builderCompletionRecoveryFile = recoveredBuilderLibraryItem');
    expect(source).toContain('if (!builderCompletionRecoveryFile?.path)');
    expect(source).toContain('artifact_path: builderCompletionRecoveryFile.path');
    expect(source).not.toContain('artifact_path: builderPrimaryFile.path');
  });
});
