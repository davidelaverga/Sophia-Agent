import { expect, test, type Page } from '@playwright/test';

import {
  endSession,
  fetchJournal,
  keepAllRecapMemories,
  openDashboard,
  parseHighlightIdsFromUrl,
  seedSophiaBrowserState,
  sendTextTurn,
  startSessionFromDashboard,
  switchToTextMode,
  type JournalEntry,
} from './live-sophia.helpers';

test.describe.configure({ mode: 'serial' });

function findHighlightedEntries(entries: JournalEntry[], highlightIds: string[]): JournalEntry[] {
  const highlightSet = new Set(highlightIds);

  return entries.filter((entry) => {
    if (highlightSet.has(entry.id)) {
      return true;
    }

    const originalMemoryId =
      entry.metadata && typeof entry.metadata.original_memory_id === 'string'
        ? entry.metadata.original_memory_id
        : null;

    return originalMemoryId ? highlightSet.has(originalMemoryId) : false;
  });
}

async function readStoredSessionId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const payload = window.localStorage.getItem('sophia-session-store');
    if (!payload) {
      return null;
    }

    try {
      const parsed = JSON.parse(payload) as {
        state?: {
          session?: {
            sessionId?: string | null;
          } | null;
        };
      };

      return parsed.state?.session?.sessionId ?? null;
    } catch {
      return null;
    }
  });
}

test('debrief ritual saves recap memories into journal', async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  await seedSophiaBrowserState(page);
  await openDashboard(page);

  const journalBefore = await fetchJournal(page);
  const uniqueToken = `RITUAL-JOURNAL-E2E-${Date.now()}`;
  const uniqueRitualDetail = `marigold-citrus blend ${uniqueToken}`;
  const memoryPrompt = [
    `Please remember this exact detail for continuity: my comfort ritual after a hard day is drinking ${uniqueRitualDetail} and taking ten quiet minutes.`,
    'Keep that as one concrete personal detail for future sessions.',
  ].join(' ');

  await startSessionFromDashboard(page, { ritual: 'debrief' });
  await switchToTextMode(page);
  await sendTextTurn(page, memoryPrompt);

  const sessionId = await readStoredSessionId(page);
  if (!sessionId) {
    throw new Error('Expected persisted sessionId after sending the ritual turn.');
  }
  const activeSessionId = sessionId;

  await endSession(page);

  await page.goto(`/recap/${activeSessionId}`);
  const keptCount = await keepAllRecapMemories(page);
  expect(keptCount).toBeGreaterThan(0);

  const saveButton = page.locator('[data-onboarding="recap-memory-save"]').first();
  await expect(saveButton).toBeVisible({ timeout: 10_000 });
  await saveButton.click();

  await page.waitForURL(/\/journal\?/, { timeout: 45_000 });

  const highlightIds = parseHighlightIdsFromUrl(page);
  expect(highlightIds.length).toBeGreaterThan(0);

  const listViewButton = page.getByRole('button', { name: 'List view' });
  await expect(listViewButton).toBeVisible({ timeout: 20_000 });
  await listViewButton.click();
  await expect(page.getByRole('heading', { name: 'Visible memories' })).toBeVisible({ timeout: 20_000 });

  const journalAfter = await fetchJournal(page);
  const highlightedEntries = findHighlightedEntries(journalAfter.entries, highlightIds);

  await testInfo.attach('journal-before.json', {
    body: JSON.stringify(journalBefore, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('journal-after.json', {
    body: JSON.stringify(journalAfter, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('journal-highlight-ids.json', {
    body: JSON.stringify({ highlightIds, keptCount }, null, 2),
    contentType: 'application/json',
  });

  expect(journalAfter.count).toBeGreaterThanOrEqual(journalBefore.count);
  expect(highlightedEntries.length).toBeGreaterThan(0);
  expect(
    highlightedEntries.some((entry) => {
      const entrySessionId =
        entry.metadata && typeof entry.metadata.session_id === 'string'
          ? entry.metadata.session_id
          : null;

      return entrySessionId === activeSessionId;
    }),
  ).toBeTruthy();
  expect(
    highlightedEntries.some((entry) => /marigold-citrus/i.test(entry.content)),
  ).toBeTruthy();
});