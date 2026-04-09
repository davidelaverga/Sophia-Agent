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

async function dismissRecapIntroIfPresent(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const introButton = page.getByRole('button', { name: 'Got it' }).first();
    if (!(await introButton.isVisible({ timeout: 2_000 }).catch(() => false))) {
      return;
    }

    await introButton.click({ force: true });
    await page.waitForTimeout(500);
  }
}

async function completeRecapReview(page: Page): Promise<number> {
  await dismissRecapIntroIfPresent(page);

  const saveButton = page.locator('[data-onboarding="recap-memory-save"]').first();
  if (await saveButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await saveButton.click();
    return 0;
  }

  const keepButton = page.getByLabel('Keep this memory').first();
  const keepVisible = await keepButton.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
  if (keepVisible) {
    const keptCount = await keepAllRecapMemories(page);

    await expect(saveButton).toBeVisible({ timeout: 10_000 });
    await saveButton.click();
    return keptCount;
  }

  await expect(saveButton).toBeVisible({ timeout: 10_000 });
  await saveButton.click();
  return 0;
}

test('journal allows editing and deleting a saved memory', async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  await seedSophiaBrowserState(page);
  await openDashboard(page);

  const journalBefore = await fetchJournal(page);
  const uniqueToken = `JOURNAL-MEMORY-ACTIONS-${Date.now()}`;
  const originalDetail = `obsidian notebook with bergamot steam ${uniqueToken}`;
  const updatedDetail = `ember-mint notebook ritual ${uniqueToken}`;
  const memoryPrompt = [
    `Please remember this exact detail for continuity: after difficult work sessions I reset by opening an ${originalDetail}, sketching three tight spirals, and listening to one minute of rain audio.`,
    'Keep that as one concrete personal detail for future sessions.',
  ].join(' ');

  await startSessionFromDashboard(page, { ritual: 'debrief' });
  await switchToTextMode(page);
  await sendTextTurn(page, memoryPrompt);

  const sessionId = await readStoredSessionId(page);
  if (!sessionId) {
    throw new Error('Expected persisted sessionId after sending the journal memory turn.');
  }

  await endSession(page);

  await page.goto(`/recap/${sessionId}`);
  const keptCount = await completeRecapReview(page);

  await page.waitForURL(/\/journal\?/, { timeout: 45_000 });

  const highlightIds = parseHighlightIdsFromUrl(page);
  expect(highlightIds.length).toBeGreaterThan(0);

  const listViewButton = page.getByRole('button', { name: 'List view' });
  await expect(listViewButton).toBeVisible({ timeout: 20_000 });
  await listViewButton.click();
  await expect(page.getByRole('heading', { name: 'Visible memories' })).toBeVisible({ timeout: 20_000 });

  const journalAfterSave = await fetchJournal(page);
  const highlightedEntries = findHighlightedEntries(journalAfterSave.entries, highlightIds);
  const targetEntry =
    highlightedEntries.find((entry) => entry.content.includes(uniqueToken)) ??
    highlightedEntries.find((entry) => {
      const entrySessionId =
        entry.metadata && typeof entry.metadata.session_id === 'string'
          ? entry.metadata.session_id
          : null;

      return entrySessionId === sessionId;
    }) ??
    highlightedEntries[0];

  expect(targetEntry, 'Expected saved journal entry for the unique memory token').toBeTruthy();
  if (!targetEntry) {
    return;
  }

  const entryExcerpt = targetEntry.content.slice(0, 80);
  const entryCard = page.locator('article', { hasText: entryExcerpt }).first();
  await expect(entryCard).toBeVisible({ timeout: 20_000 });

  await entryCard.getByRole('button', { name: 'Edit' }).click();

  const editingCard = page.locator('article').filter({
    has: page.getByRole('textbox', { name: /Edit .* memory/i }),
  }).first();
  const editField = editingCard.getByRole('textbox', { name: /Edit .* memory/i });
  await expect(editField).toBeVisible({ timeout: 10_000 });
  await editField.fill(`After difficult work sessions I reset with ${updatedDetail}.`);
  await editingCard.getByRole('button', { name: 'Save' }).click();

  const updatedEntryCard = page.locator('article', { hasText: updatedDetail }).first();
  await expect(updatedEntryCard.getByText(updatedDetail)).toBeVisible({ timeout: 20_000 });
  await expect(updatedEntryCard.getByText(originalDetail)).toHaveCount(0);

  const journalAfterEdit = await fetchJournal(page);
  expect(journalAfterEdit.entries.some((entry) => entry.content.includes(updatedDetail))).toBeTruthy();
  expect(journalAfterEdit.entries.some((entry) => entry.content.includes(originalDetail))).toBeFalsy();

  page.once('dialog', (dialog) => dialog.accept());
  await updatedEntryCard.getByRole('button', { name: 'Delete' }).click();

  await expect(page.locator('article', { hasText: updatedDetail })).toHaveCount(0, { timeout: 20_000 });

  const journalAfterDelete = await fetchJournal(page);

  await testInfo.attach('journal-before.json', {
    body: JSON.stringify(journalBefore, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('journal-after-save.json', {
    body: JSON.stringify(journalAfterSave, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('journal-after-edit.json', {
    body: JSON.stringify(journalAfterEdit, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('journal-after-delete.json', {
    body: JSON.stringify(journalAfterDelete, null, 2),
    contentType: 'application/json',
  });

  expect(journalAfterDelete.entries.some((entry) => entry.content.includes(updatedDetail))).toBeFalsy();
  expect(journalAfterDelete.count).toBeLessThan(journalAfterEdit.count);
});