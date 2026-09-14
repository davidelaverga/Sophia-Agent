// Actual frontend checker -> installed loopback HTTP server/queue/worker.
// Bearer/source resolution and the minimal graph remain synthetic seams.
import { describe, expect, it } from 'vitest';

import { createRunCompletionCheck } from '../../../app/api/chat/_lib/run-completion';

const input = process.env.MEM00_HTTP_RUN_CASES;
const cases = input ? JSON.parse(input) as Array<{ name: string; base: string; thread: string; location: string; status: string }> : [];
describe.skipIf(!input)('installed HTTP run completion', () => {
  for (const name of ['success', 'error', 'disconnect_continue']) {
    it(name, async () => {
      const row = cases.find(item => item.name === name);
      if (!row) throw new Error('native_http_case_missing');
      expect(new URL(row.base).hostname).toBe('127.0.0.1');
      const check = (token: string) => createRunCompletionCheck({
        backendUrl: row.base + '/threads', threadId: row.thread, token,
        upstream: new Response('', { headers: { 'Content-Location': row.location } }),
      });
      const original = check('synthetic-owner-a');
      expect(await original()).toBe(row.status === 'success');
      expect(await original()).toBe(false);
      expect(await check('synthetic-owner-b')()).toBe(false);
      expect(await check('synthetic-unavailable')()).toBe(false);
      expect(await check('synthetic-invalid')()).toBe(false);
    });
  }
});
