import { beforeEach, describe, expect, it } from 'vitest';

import {
  bindSophiaCaptureSyntheticTestContext,
  readSophiaCaptureEventsAfter,
  recordSophiaCaptureEvent,
  registerSophiaCaptureBridge,
  type SophiaCaptureCursor,
} from '../../app/lib/session-capture';

describe('session capture cursor drain', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.__SOPHIA_CAPTURE_ENABLED__ = true;
    delete window.__sophiaCapture;
    delete window.__sophiaCaptureState;
  });

  it('drains more than the 500-event ring capacity without a cursor gap or duplicate', () => {
    let cursor: SophiaCaptureCursor = { generation: 1, seq: 0 };
    const drainedSequences: number[] = [];
    let lastMetadata = readSophiaCaptureEventsAfter(cursor).metadata;

    for (let index = 1; index <= 750; index += 1) {
      recordSophiaCaptureEvent({
        category: 'vt00-test',
        name: 'bounded-ring-event',
        payload: { index },
      });
      if (index % 25 === 0) {
        const drained = readSophiaCaptureEventsAfter(cursor);
        expect(drained.metadata.gap).toBe(false);
        drainedSequences.push(...drained.events.map((event) => event.seq));
        cursor = drained.cursor;
        lastMetadata = drained.metadata;
      }
    }

    expect(drainedSequences).toEqual(Array.from({ length: 750 }, (_, index) => index + 1));
    expect(new Set(drainedSequences).size).toBe(750);
    expect(cursor).toEqual({ generation: 1, seq: 750 });
    expect(lastMetadata).toMatchObject({
      generation: 1,
      capacity: 500,
      oldestSeq: 251,
      latestSeq: 750,
      totalProduced: 750,
      droppedCount: 250,
      gap: false,
      gapReason: null,
    });
  });

  it('reports an explicit gap for a lagged cursor and for a cleared generation', () => {
    for (let index = 1; index <= 510; index += 1) {
      recordSophiaCaptureEvent({ category: 'vt00-test', name: `event-${index}` });
    }

    const lagged = readSophiaCaptureEventsAfter({ generation: 1, seq: 0 });
    expect(lagged.metadata).toMatchObject({
      oldestSeq: 11,
      latestSeq: 510,
      droppedCount: 10,
      gap: true,
      gapReason: 'cursor_before_oldest',
    });

    registerSophiaCaptureBridge();
    window.__sophiaCapture?.clear();
    recordSophiaCaptureEvent({ category: 'vt00-test', name: 'new-generation-event' });
    const afterClear = window.__sophiaCapture?.readAfter({ generation: 1, seq: 510 });

    expect(afterClear?.cursor).toEqual({ generation: 2, seq: 1 });
    expect(afterClear?.metadata).toMatchObject({
      generation: 2,
      totalProduced: 1,
      droppedCount: 0,
      gap: true,
      gapReason: 'generation_mismatch',
    });
    expect(afterClear?.events.map((event) => event.name)).toEqual(['new-generation-event']);
  });

  it('attaches product-authored exact-run provenance to every later capture event and snapshot', () => {
    const syntheticTest = {
      synthetic: true as const,
      principal_id: 'voice-lab-user-1',
      test_run_id: 'run-001',
      scenario_id: 'vt00-realtime-001',
      scenario_version: 'v1',
      environment: 'production',
      retention_hours: 24,
      cleanup_obligation_id: '123e4567-e89b-42d3-a456-426614174000',
      provider_expires_at: '2033-05-18T04:03:20.000Z',
    };
    bindSophiaCaptureSyntheticTestContext(syntheticTest);
    recordSophiaCaptureEvent({
      category: 'voice-session',
      name: 'gemini-output-leg-receipt',
      payload: { monitorDigestSha256: 'a'.repeat(64), rawAudioExcluded: true },
    });
    registerSophiaCaptureBridge();

    const event = readSophiaCaptureEventsAfter(null).events[0];
    expect(event.synthetic_test).toEqual(syntheticTest);
    expect(window.__sophiaCapture?.snapshot().metadata.synthetic_test).toEqual(syntheticTest);
  });

  it('mirrors each exact recorded event to the private page notification lane', () => {
    let mirrored: unknown = null;
    const listener = (event: Event) => {
      mirrored = (event as CustomEvent).detail;
    };
    window.addEventListener('sophia:capture-event', listener, { once: true });

    recordSophiaCaptureEvent({
      category: 'voice-session',
      name: 'gemini-provider-connection-epoch',
      payload: { receipt: { providerConnectionEpoch: 3 } },
    });

    expect(mirrored).toMatchObject({
      generation: 1,
      seq: 1,
      category: 'voice-session',
      name: 'gemini-provider-connection-epoch',
      payload: { receipt: { providerConnectionEpoch: 3 } },
    });
  });
});
