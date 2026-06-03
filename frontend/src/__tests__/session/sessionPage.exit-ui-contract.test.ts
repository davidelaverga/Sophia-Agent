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

  it('keeps Coreview artifact review scoped to the artifact panel, not a root fixture launcher', () => {
    const source = readAppFile('app/session/page.tsx');
    const oldLauncherName = ['Coreview', 'Fixture', 'Launcher'].join('');
    const oldFlagName = ['coReview', 'Fixture', 'Enabled'].join('');

    expect(source).not.toContain(`<${oldLauncherName}`);
    expect(source).not.toContain(oldFlagName);
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

  it('uses a split text workspace when a builder artifact stage is open', () => {
    const source = readAppFile('app/session/page.tsx');

    expect(source).toContain('const showTextArtifactStage = focusMode === \'text\'');
    expect(source).toContain('Boolean(builderArtifact) || hasBuilderArtifactLibrary');
    expect(source).toContain('session-text-split-workspace');
    expect(source).toContain('session-conversation-area');
    expect(source).toContain('session-artifact-stage-area');
    expect(source).toContain('lg:grid-cols-[minmax(360px,0.38fr)_minmax(0,1fr)]');
    expect(source).toContain('xl:grid-cols-[minmax(420px,0.34fr)_minmax(720px,1fr)]');
  });

  it('keeps text-mode builder preview to one artifact surface while voice mode uses the same source props', () => {
    const source = readAppFile('app/session/page.tsx');

    expect(source).toContain('const showInlineTextArtifactsPanel = focusMode === \'text\'');
    expect(source).toContain('const showVoiceArtifactStage = focusMode !== \'text\'');
    expect(source).toContain('&& !showTextArtifactStage');
    expect(source).toContain('focusMode === \'text\' && !showTextArtifactStage && builderCompletionForDisplay');
    expect(source).toContain('focusMode !== \'text\' && !showVoiceArtifactStage && builderCompletionForDisplay');
    expect(source).toContain('{showTextArtifactStage && (');
    expect(source).toContain("{focusMode !== 'text' && (");
    expect(source).toContain('<VoiceFirstComposer');
    expect(source).toContain('const handleStartVoiceBuilderArtifactReview = useCallback(() => {');
    expect(source).toContain("setFocusMode('voice')");
    expect(source.match(/selectedBuilderArtifactPath={selectedBuilderArtifactPath}/g)?.length).toBe(3);
    expect(source.match(/onSelectedBuilderArtifactPathChange={handleSelectBuilderArtifactPath}/g)?.length).toBe(3);
    expect(source.match(/pendingBuilderArtifactReview={pendingBuilderArtifactReview}/g)?.length).toBe(3);
    expect(source.match(/onStartVoiceBuilderArtifactReview={handleStartVoiceBuilderArtifactReview}/g)?.length).toBe(3);
  });
});
