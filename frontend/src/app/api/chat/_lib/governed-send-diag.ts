import { diagElapsedMs, diagLog, diagNow } from '../../../lib/diag-log';

const UUID_JOIN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidJoin(value: string | null): string | null {
  return typeof value === 'string' && UUID_JOIN.test(value) ? value.toLowerCase() : null;
}

/**
 * One production line per governed chat send: `chat.governed_send`.
 *
 * The rest of /api/chat logging is dark in production (`secureLog`), so this
 * line goes straight to diagLog (a single-string console.warn, which
 * `removeConsole` keeps). It carries ids, per-stage waits, the upstream status
 * and an outcome code only: never message text, user ids or tokens.
 */

export type GovernedSendStage =
  | 'boundary'
  | 'session'
  | 'token'
  | 'authority'
  | 'ownership'
  | 'upstream_headers';

export type GovernedSendOutcome =
  | 'not_authenticated'
  | 'invalid_user'
  | 'authority_unavailable'
  | 'authority_mismatch'
  | 'runtime_unavailable'
  | 'ownership_rejected'
  | 'upstream_refused'
  | 'upstream_unconfirmed'
  | 'upstream_not_stream'
  | 'stream_started'
  | 'backend_unavailable'
  | 'service_unavailable';

export type GovernedSendDiag = {
  /** Run one stage and record how long it took, whether it resolved or threw. */
  time: <T>(stage: GovernedSendStage, run: () => Promise<T>) => Promise<T>;
  /** The request carries a governed source action; only then is a line emitted. */
  markGoverned: (ids: { messageId: string; threadId: string | null }) => void;
  setOutcome: (outcome: GovernedSendOutcome, upstreamStatus?: number) => void;
  /** Emit the line once; a no-op for a send that was never marked governed. */
  emit: () => void;
};

export function createGovernedSendDiag(): GovernedSendDiag {
  const startedAt = diagNow();
  const stageMs: Partial<Record<GovernedSendStage, number>> = {};
  let ids: { messageId: string | null; threadId: string | null } | null = null;
  let outcome: GovernedSendOutcome | null = null;
  let upstreamStatus: number | null = null;
  let emitted = false;

  return {
    time: async (stage, run) => {
      const stageStartedAt = diagNow();
      try {
        return await run();
      } finally {
        stageMs[stage] = diagElapsedMs(stageStartedAt);
      }
    },
    markGoverned: (nextIds) => {
      // The source contract also accepts arbitrary action keys. They are
      // legitimate request metadata, but never safe diagnostic join values.
      ids = { messageId: uuidJoin(nextIds.messageId), threadId: uuidJoin(nextIds.threadId) };
    },
    setOutcome: (nextOutcome, nextUpstreamStatus) => {
      outcome = nextOutcome;
      if (typeof nextUpstreamStatus === 'number') upstreamStatus = nextUpstreamStatus;
    },
    emit: () => {
      if (!ids || emitted) return;
      emitted = true;
      diagLog('chat.governed_send', {
        message_id: ids.messageId,
        thread_id: ids.threadId,
        boundary_ms: stageMs.boundary ?? null,
        session_ms: stageMs.session ?? null,
        token_ms: stageMs.token ?? null,
        authority_ms: stageMs.authority ?? null,
        ownership_ms: stageMs.ownership ?? null,
        upstream_headers_ms: stageMs.upstream_headers ?? null,
        upstream_status: upstreamStatus,
        outcome: outcome ?? 'service_unavailable',
        total_ms: diagElapsedMs(startedAt),
      });
    },
  };
}
