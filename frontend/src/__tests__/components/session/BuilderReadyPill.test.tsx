import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(testDirectory, '../../..');

function readSource(relativePath: string) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8');
}

describe('BuilderReadyPill session isolation', () => {
  it('is not mounted by the canonical session builder flow', () => {
    const pageSource = readSource('app/session/page.tsx');
    const noticeSource = readSource('app/components/session/BuilderTaskNotice.tsx');

    expect(pageSource).not.toContain('BuilderReadyPill');
    expect(noticeSource).not.toContain('BuilderReadyPill');
    expect(pageSource).toContain('builderSurface.showCanonicalCompletedBuilder');
    expect(pageSource).toContain('<BuilderTaskNotice');
  });
});
