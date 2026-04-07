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
});