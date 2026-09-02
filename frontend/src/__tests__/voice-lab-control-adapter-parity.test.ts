import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const dashboardSource = readFileSync(
  path.join(process.cwd(), 'src/app/components/dashboard/useDashboardEntryState.ts'),
  'utf8',
);
const sessionSource = readFileSync(
  path.join(process.cwd(), 'src/app/session/page.tsx'),
  'utf8',
);

describe('Voice Lab controller parity', () => {
  it('routes dashboard authorization through the exact visible microphone callback', () => {
    expect(dashboardSource).toContain(
      "useVoiceLabControlAdapter('session-start', handleCallSophia)",
    );
    expect(dashboardSource).not.toContain('handleVoiceLabSessionStart');
  });

  it('routes session authorization through the exact visible composer callback', () => {
    expect(sessionSource).toContain(
      "useVoiceLabControlAdapter('voice-start', handleMicClick)",
    );
    expect(sessionSource).not.toContain('handleVoiceLabVoiceStart');
  });
});
