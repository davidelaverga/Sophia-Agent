import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { VoiceLabError, labError } from "../src/domain.js";
import type { EventAppendInput, VoiceLabLedger } from "../src/ledger.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { PostgresVoiceLabLedger } from "../src/postgres-ledger.js";
import { sha256 } from "../src/security.js";
import { composeServiceFenceV2Migration } from "../src/service-fence-migration.js";
import { completeExecutionCleanupFixture } from "./execution-cleanup-fixture.js";
import { testRun } from "./helpers.js";

/**
 * #151 (root's TOCTOU review of d2d550e5): browser capture persistence bound
 * to a lease is enforced at the write's linearization point, inside the same
 * serialization as the capture insert and its cursor and join effects. A lease
 * removed, fenced or expired before that point refuses everything; a lease
 * change after it waits for the write to end. Writes that are not browser
 * capture (recovery, cleanup) keep their behaviour and need no lease.
 */

const WORKER = "capture-worker";
const capture = (label: string, count = 2): EventAppendInput[] => Array.from({ length: count }, (_, index) => ({
  kind: "harness.input_frame_forwarded", source: "browser", payload: { label, index }, dedupeKey: `capture:${label}:${index}`,
}));
const joinThread = (threadId: string) => () => ({ canonicalSessionId: null, threadId, providerSessionId: null, traceId: null, providerEpoch: null, turnId: null });

async function liveRun(ledger: VoiceLabLedger, leaseSeconds = 30) {
  const run = testRun({ expiresAt: new Date(Date.now() + 3_600_000) });
  await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 100, caller: 100 });
  const lease = await ledger.upsertBrowserLease(run.id, WORKER, leaseSeconds);
  return { run, lease };
}

async function sideEffects(ledger: VoiceLabLedger, runId: string) {
  const run = (await ledger.getRun(runId))!;
  const events = (await ledger.listEvents(runId, 0, 1_000)).events;
  return { cursor: run.latestCursor, version: run.version, threadId: run.threadId, captured: events.filter((event) => event.kind === "harness.input_frame_forwarded").length };
}

/** The ledger-independent proof, run against both stores. */
function contract(store: () => VoiceLabLedger, sleep: (ms: number) => Promise<void>) {
  it("control: a live exact lease commits the batch, its cursor advance and its join together", async () => {
    const ledger = store();
    const { run, lease } = await liveRun(ledger);
    const before = await sideEffects(ledger, run.id);
    await expect(ledger.appendLeaseBoundEvents(run.id, { workerId: WORKER, leaseEpoch: lease.leaseEpoch }, capture("live"), joinThread("thread-live"))).resolves.toEqual({ committed: true, appended: 2 });
    expect(await sideEffects(ledger, run.id)).toEqual({ cursor: before.cursor + 2, version: before.version + 1, threadId: "thread-live", captured: 2 });
    // An exact replay of the same keys writes nothing more.
    await expect(ledger.appendLeaseBoundEvents(run.id, { workerId: WORKER, leaseEpoch: lease.leaseEpoch }, capture("live"))).resolves.toEqual({ committed: true, appended: 0 });
    expect((await sideEffects(ledger, run.id)).captured).toBe(2);
  });

  it("root's repro: the exact lease is CAS-released before the append starts; the append refuses with no row, cursor or join", async () => {
    const ledger = store();
    const { run, lease } = await liveRun(ledger);
    expect(await ledger.releaseBrowserLease(run.id, WORKER, lease.leaseEpoch)).toBe(true);
    expect(await ledger.getBrowserLease(run.id)).toBeNull();
    const before = await sideEffects(ledger, run.id);
    await expect(ledger.appendLeaseBoundEvents(run.id, { workerId: WORKER, leaseEpoch: lease.leaseEpoch }, capture("released"), joinThread("thread-released"))).resolves.toEqual({ committed: false });
    expect(await sideEffects(ledger, run.id)).toEqual(before);
  });

  it("fenced: another worker or another epoch than the lease's refuses with no side effect", async () => {
    const ledger = store();
    const { run, lease } = await liveRun(ledger);
    const before = await sideEffects(ledger, run.id);
    await expect(ledger.appendLeaseBoundEvents(run.id, { workerId: "other-worker", leaseEpoch: lease.leaseEpoch }, capture("other-worker"), joinThread("thread-x"))).resolves.toEqual({ committed: false });
    await expect(ledger.appendLeaseBoundEvents(run.id, { workerId: WORKER, leaseEpoch: lease.leaseEpoch + 1 }, capture("other-epoch"), joinThread("thread-y"))).resolves.toEqual({ committed: false });
    expect(await sideEffects(ledger, run.id)).toEqual(before);
  });

  it("expired: a lease past its expiry before the append refuses with no side effect", async () => {
    const ledger = store();
    const { run, lease } = await liveRun(ledger, 1);
    await sleep(1_300);
    const before = await sideEffects(ledger, run.id);
    await expect(ledger.appendLeaseBoundEvents(run.id, { workerId: WORKER, leaseEpoch: lease.leaseEpoch }, capture("expired"), joinThread("thread-expired"))).resolves.toEqual({ committed: false });
    expect(await sideEffects(ledger, run.id)).toEqual(before);
  });

  it("a refused batch is refused whole: a dedupe conflict inside it writes nothing", async () => {
    const ledger = store();
    const { run, lease } = await liveRun(ledger);
    await ledger.appendLeaseBoundEvents(run.id, { workerId: WORKER, leaseEpoch: lease.leaseEpoch }, capture("dedupe", 1));
    const before = await sideEffects(ledger, run.id);
    const conflicting = [...capture("fresh", 1), { ...capture("dedupe", 1)[0]!, payload: { label: "dedupe", index: 0, drifted: true } }];
    await expect(ledger.appendLeaseBoundEvents(run.id, { workerId: WORKER, leaseEpoch: lease.leaseEpoch }, conflicting, joinThread("thread-dedupe"))).rejects.toMatchObject({ detail: { code: "DEDUPE_CONFLICT" } });
    expect(await sideEffects(ledger, run.id)).toEqual(before);
  });

  it.each([
    ["JOIN_CORRELATION_CONFLICT", "Conflicting thread_id values were observed from strict owning receipts."],
    ["PROVIDER_EPOCH_REGRESSION", "Provider epoch regressed across strict product receipts."],
  ])("a %s join derivation under a live lease keeps the batch and cursor as evidence, applies no join, and is rethrown", async (code, message) => {
    const ledger = store();
    const { run, lease } = await liveRun(ledger);
    const before = await sideEffects(ledger, run.id);
    const failingJoin = () => { throw new VoiceLabError(labError(code, message, "harness", false)); };
    await expect(ledger.appendLeaseBoundEvents(run.id, { workerId: WORKER, leaseEpoch: lease.leaseEpoch }, capture(`join-${code}`), failingJoin)).rejects.toMatchObject({ detail: { code } });
    expect(await sideEffects(ledger, run.id)).toEqual({ cursor: before.cursor + 2, version: before.version, threadId: before.threadId, captured: 2 });
  });

  it("the same failing join derivation under a refused lease writes nothing and is not reached", async () => {
    const ledger = store();
    const { run, lease } = await liveRun(ledger);
    expect(await ledger.releaseBrowserLease(run.id, WORKER, lease.leaseEpoch)).toBe(true);
    const before = await sideEffects(ledger, run.id);
    let derived = false;
    const failingJoin = () => { derived = true; throw new VoiceLabError(labError("JOIN_CORRELATION_CONFLICT", "conflict", "harness", false)); };
    await expect(ledger.appendLeaseBoundEvents(run.id, { workerId: WORKER, leaseEpoch: lease.leaseEpoch }, capture("join-refused"), failingJoin)).resolves.toEqual({ committed: false });
    expect(derived).toBe(false);
    expect(await sideEffects(ledger, run.id)).toEqual(before);
  });

  it("non-capture writes keep their behaviour: recovery and cleanup writes need no lease", async () => {
    const ledger = store();
    const { run, lease } = await liveRun(ledger);
    expect(await ledger.releaseBrowserLease(run.id, WORKER, lease.leaseEpoch)).toBe(true);
    const before = await sideEffects(ledger, run.id);
    await ledger.appendEvent(run.id, "cleanup.recovery", "canonical", { complete: true }, `recovery:${run.id}`);
    await ledger.appendEvents(run.id, [{ kind: "cleanup.browser_lease_released", source: "worker", payload: { cas_deleted: true }, dedupeKey: `cleanup:${run.id}:browser-lease` }]);
    const fresh = (await ledger.getRun(run.id))!;
    await ledger.updateRun(run.id, fresh.version, { threadId: "thread-recovered" });
    expect(await sideEffects(ledger, run.id)).toEqual({ cursor: before.cursor + 2, version: before.version + 1, threadId: "thread-recovered", captured: 0 });
  });
}

describe("lease-bound capture: memory store", () => {
  contract(() => new MemoryVoiceLabLedger("test"), async (ms) => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    vi.setSystemTime(Date.now() + ms);
  });

  afterEach(() => { vi.useRealTimers(); });

  it("serializes against a release issued right behind the append: the whole batch, through its join, lands before the release", async () => {
    const ledger = new MemoryVoiceLabLedger("test");
    const { run, lease } = await liveRun(ledger);
    const before = await sideEffects(ledger, run.id);
    let releaseIssued = false;
    let joinedAfterRelease: boolean | null = null;
    // The join is derived last, inside the write; the release is issued in the same synchronous turn right after the append is called.
    const appending = ledger.appendLeaseBoundEvents(run.id, { workerId: WORKER, leaseEpoch: lease.leaseEpoch }, capture("racing"), () => {
      joinedAfterRelease = releaseIssued;
      return joinThread("thread-racing")();
    });
    const releasing = ledger.releaseBrowserLease(run.id, WORKER, lease.leaseEpoch);
    releaseIssued = true;
    const [appended, released] = await Promise.all([appending, releasing]);
    expect(released).toBe(true);
    expect(appended).toEqual({ committed: true, appended: 2 });
    expect(joinedAfterRelease, "no part of the capture write ran after the release").toBe(false);
    expect(await sideEffects(ledger, run.id)).toEqual({ cursor: before.cursor + 2, version: before.version + 1, threadId: "thread-racing", captured: 2 });
  });

  it("refuses whole when the release is issued right before the append", async () => {
    const ledger = new MemoryVoiceLabLedger("test");
    const { run, lease } = await liveRun(ledger);
    const before = await sideEffects(ledger, run.id);
    const releasing = ledger.releaseBrowserLease(run.id, WORKER, lease.leaseEpoch);
    const appending = ledger.appendLeaseBoundEvents(run.id, { workerId: WORKER, leaseEpoch: lease.leaseEpoch }, capture("late"), joinThread("thread-late"));
    expect(await releasing).toBe(true);
    expect(await appending).toEqual({ committed: false });
    expect(await sideEffects(ledger, run.id)).toEqual(before);
  });
});

const url = process.env.SOPHIA_VOICE_LAB_CAPTURE_TEST_DATABASE_URL ?? "";
const postgres = url ? describe : describe.skip;

postgres("lease-bound capture: real PostgreSQL", () => {
  let ledger: PostgresVoiceLabLedger;
  let admin: pg.Client;

  beforeAll(async () => {
    const parsed = new URL(url);
    if (!/^\/voice_lab_test_capture_[a-z0-9_]+$/.test(parsed.pathname) || process.env.SOPHIA_VOICE_LAB_TEST_DATABASE_RESET_APPROVED !== "YES") throw new Error("Dedicated capture-test database and reset approval required");
    ledger = new PostgresVoiceLabLedger(url, 6);
    expect((await ledger.pool.query("select current_database() as name")).rows[0].name).toBe(parsed.pathname.slice(1));
    await ledger.pool.query("drop schema if exists sophia_voice_lab cascade");
    await ledger.pool.query(composeServiceFenceV2Migration(await readFile("../../backend/migrations/2026_08_23_sophia_voice_lab.sql"), await readFile("migrations/004_recovery_controls.sql"),
      await readFile("migrations/005_service_owner_fence.sql"), await readFile("migrations/006_service_fence_v2.sql")).toString("utf8"));
    admin = new pg.Client({ connectionString: url, application_name: "capture-test-admin" });
    await admin.connect();
  });
  afterAll(async () => {
    await admin?.end();
    if (!ledger) return;
    try { await ledger.pool.query("drop schema if exists sophia_voice_lab cascade"); } finally { await ledger.close(); }
  });

  contract(() => ledger, (ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  /** Waits until a backend running `fragment` waits on a lock. */
  async function blockedOn(fragment: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await admin.query("select count(*)::int as n from pg_stat_activity where wait_event_type='Lock' and query like $1", [`%${fragment}%`]);
      if (waiting.rows[0].n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no backend blocked on ${fragment}`);
  }

  async function holding(sql: string, params: unknown[]): Promise<pg.Client> {
    const session = new pg.Client({ connectionString: url, application_name: "capture-test-holder" });
    await session.connect();
    await session.query("begin");
    await session.query(sql, params);
    return session;
  }

  /** The pg_stat_activity row of a ledger backend that runs `fragment` and waits on a lock the backend `holderPid` holds. */
  async function lockWaitBehind(holderPid: number, fragment: string): Promise<{ wait_event_type: string; wait_event: string; blocked_by_holder: boolean }> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await admin.query(
        "select wait_event_type, wait_event, $1::int = any(pg_blocking_pids(pid)) as blocked_by_holder from pg_stat_activity where application_name='sophia-voice-lab' and wait_event_type='Lock' and query like $2",
        [holderPid, `%${fragment}%`],
      );
      if (waiting.rows[0]) return waiting.rows[0];
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no ledger backend waiting on a lock while running ${fragment}`);
  }

  /** Holds the run's lease row FOR UPDATE on its own session and leaves it unchanged: a lock-only holder. */
  async function lockOnlyLeaseHolder(runId: string): Promise<{ session: pg.Client; pid: number }> {
    const session = await holding("select 1 from sophia_voice_lab.browser_leases where run_id=$1 for update", [runId]);
    return { session, pid: (await session.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid };
  }

  const leaseExpired = async (runId: string): Promise<boolean> => (await admin.query("select expires_at <= clock_timestamp() as expired from sophia_voice_lab.browser_leases where run_id=$1", [runId])).rows[0].expired;
  /** A domain refusal settles as `rejected: <code>`; any other error (a lock or statement timeout, SQL, setup) as `harnessError`. */
  type Settled = { waitedMs: number; result?: unknown; rejected?: string; harnessError?: string };
  const settled = (work: Promise<unknown>): Promise<Settled> => {
    const started = Date.now();
    return work.then((result) => ({ result, waitedMs: Date.now() - started }), (error: unknown) => error instanceof VoiceLabError
      ? { rejected: error.detail.code, waitedMs: Date.now() - started }
      : { harnessError: (error as { code?: string }).code ?? String(error), waitedMs: Date.now() - started });
  };

  it("root's P2: another session holds the exact lease row FOR UPDATE and leaves it unchanged while the append waits on it; the lease expires during that wait; the append refuses whole", async () => {
    const { run, lease } = await liveRun(ledger, 1);
    const before = await sideEffects(ledger, run.id);
    const leaseBefore = await ledger.getBrowserLease(run.id);
    const holder = await lockOnlyLeaseHolder(run.id);
    let outcome: Settled = { waitedMs: -1, harnessError: "not settled" };
    try {
      const appending = settled(ledger.appendLeaseBoundEvents(run.id, { workerId: WORKER, leaseEpoch: lease.leaseEpoch }, capture("lock-only-holder"), joinThread("thread-lock-only-holder")));
      // The actual lock wait, read from pg_stat_activity: the append's lease statement, blocked by the holder's backend.
      const wait = await lockWaitBehind(holder.pid, "from sophia_voice_lab.browser_leases where run_id=$1 and worker_id=$2 and lease_epoch=$3");
      console.info(`root P2 append: ledger backend wait_event_type=${wait.wait_event_type} wait_event=${wait.wait_event} blocked_by_holder=${wait.blocked_by_holder}`);
      expect(wait).toMatchObject({ wait_event_type: "Lock", blocked_by_holder: true });
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      expect(await leaseExpired(run.id)).toBe(true);
      await holder.session.query("rollback");
      outcome = await appending;
    } finally { await holder.session.end(); }
    console.info(`root P2 append: outcome ${JSON.stringify(outcome)} (ledger lock_timeout 2000 ms)`);
    const { waitedMs, ...settledAs } = outcome;
    expect({ outcome: settledAs, effects: await sideEffects(ledger, run.id) }).toEqual({ outcome: { result: { committed: false } }, effects: before });
    expect(waitedMs).toBeLessThan(2_000);
    expect(await ledger.getBrowserLease(run.id), "the holder left the lease row unchanged").toEqual(leaseBefore);
  });

  /**
   * Root's unchanged-tuple shape, for any statement that waits on the run's
   * lease row: another session holds the row FOR UPDATE and leaves it
   * unchanged; the ledger backend's Lock wait behind that session is read from
   * pg_stat_activity; the 1 s lease expires during a 1.3 s wait (verified on
   * the database clock); the holder rolls back. Returns how the work settled.
   */
  async function behindLockOnlyHolder(label: string, runId: string, fragment: string, work: () => Promise<unknown>): Promise<Settled> {
    const holder = await lockOnlyLeaseHolder(runId);
    try {
      const running = settled(work());
      const wait = await lockWaitBehind(holder.pid, fragment);
      console.info(`${label}: ledger backend wait_event_type=${wait.wait_event_type} wait_event=${wait.wait_event} blocked_by_holder=${wait.blocked_by_holder}`);
      expect(wait).toMatchObject({ wait_event_type: "Lock", blocked_by_holder: true });
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      expect(await leaseExpired(runId)).toBe(true);
      await holder.session.query("rollback");
      const outcome = await running;
      console.info(`${label}: outcome ${JSON.stringify(outcome)} (ledger lock_timeout 2000 ms)`);
      return outcome;
    } finally { await holder.session.end(); }
  }

  /** A run whose 1 s lease is preceded by the receipts preserveExecutionOwnership derives the owner from. */
  async function ownedRun(leaseSeconds: number) {
    const { run, lease } = await liveRun(ledger, leaseSeconds);
    for (const event of completeExecutionCleanupFixture(run, WORKER, lease.leaseEpoch).slice(0, 2)) await ledger.appendEvent(run.id, event.kind, event.source, event.payload);
    return { run, lease };
  }

  const LEASE_KEY = "sophia_voice_lab.browser_leases%where run_id=$1 and worker_id=$2 and lease_epoch=$3";
  const RUN_LEASE_LOCK = "sophia_voice_lab.browser_leases where run_id=$1 for update";

  it("heartbeatBrowserLease (predates 1c183ee6): another session holds the exact lease row FOR UPDATE and leaves it unchanged while the renewal waits on it; the lease expires during that wait; the renewal refuses and the lease is not revived", async () => {
    const { run, lease } = await liveRun(ledger, 1);
    const leaseBefore = await ledger.getBrowserLease(run.id);
    const { waitedMs, ...outcome } = await behindLockOnlyHolder("heartbeat", run.id, LEASE_KEY, () => ledger.heartbeatBrowserLease(run.id, WORKER, lease.leaseEpoch, 30));
    expect({ outcome, lease: await ledger.getBrowserLease(run.id) }).toEqual({ outcome: { result: false }, lease: leaseBefore });
    expect(waitedMs).toBeLessThan(2_000);
    expect(await leaseExpired(run.id), "the lease is not revived").toBe(true);
    // A refused renewal stays refused: the expired lease is never renewed by a later call either.
    await expect(ledger.heartbeatBrowserLease(run.id, WORKER, lease.leaseEpoch, 30)).resolves.toBe(false);
    expect(await ledger.getBrowserLease(run.id)).toEqual(leaseBefore);
  });

  it("heartbeatBrowserLease (predates 1c183ee6): behind a lease-bound capture write that holds the lease row FOR SHARE and commits it unchanged, a renewal that waited past the lease's expiry refuses", async () => {
    const { run, lease } = await liveRun(ledger, 1);
    const leaseBefore = await ledger.getBrowserLease(run.id);
    // A test-only trigger on this dedicated database pauses the capture insert, which runs after the append's lease check, while it holds the lease row FOR SHARE.
    await admin.query(`create or replace function sophia_voice_lab.capture_test_hold() returns trigger language plpgsql as $$
      begin if new.payload->>'hold' = 'true' then perform pg_sleep(1.5); end if; return new; end $$`);
    await admin.query("create trigger capture_test_hold before insert on sophia_voice_lab.run_events for each row execute function sophia_voice_lab.capture_test_hold()");
    let outcome: Settled = { waitedMs: -1, harnessError: "not settled" };
    try {
      const batch = capture("share-holder", 1).map((input) => ({ ...input, payload: { ...input.payload, hold: true } }));
      const appending = ledger.appendLeaseBoundEvents(run.id, { workerId: WORKER, leaseEpoch: lease.leaseEpoch }, batch);
      let appendPid: number | undefined;
      for (let attempt = 0; attempt < 100 && appendPid === undefined; attempt += 1) {
        appendPid = (await admin.query("select pid from pg_stat_activity where application_name='sophia-voice-lab' and wait_event='PgSleep'")).rows[0]?.pid;
        if (appendPid === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (appendPid === undefined) throw new Error("the capture write never reached its held insert");
      const renewing = settled(ledger.heartbeatBrowserLease(run.id, WORKER, lease.leaseEpoch, 30));
      const wait = await lockWaitBehind(appendPid, LEASE_KEY);
      console.info(`heartbeat behind FOR SHARE: ledger backend wait_event_type=${wait.wait_event_type} wait_event=${wait.wait_event} blocked_by_append=${wait.blocked_by_holder}`);
      expect(wait).toMatchObject({ wait_event_type: "Lock", blocked_by_holder: true });
      for (let attempt = 0; attempt < 70 && !await leaseExpired(run.id); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await leaseExpired(run.id), "the lease expired while the capture write still held it FOR SHARE").toBe(true);
      await expect(appending).resolves.toEqual({ committed: true, appended: 1 });
      outcome = await renewing;
      console.info(`heartbeat behind FOR SHARE: outcome ${JSON.stringify(outcome)} (ledger lock_timeout 2000 ms)`);
    } finally {
      await admin.query("drop trigger if exists capture_test_hold on sophia_voice_lab.run_events");
      await admin.query("drop function if exists sophia_voice_lab.capture_test_hold()");
    }
    const { waitedMs, ...settledAs } = outcome;
    expect({ outcome: settledAs, lease: await ledger.getBrowserLease(run.id) }).toEqual({ outcome: { result: false }, lease: leaseBefore });
    expect(waitedMs).toBeLessThan(2_000);
  });

  it("heartbeatBrowserLease control: behind the same lock-only holder, a live lease is renewed once the holder rolls back", async () => {
    const { run, lease } = await liveRun(ledger, 30);
    const leaseBefore = (await ledger.getBrowserLease(run.id))!;
    const holder = await lockOnlyLeaseHolder(run.id);
    try {
      const renewing = settled(ledger.heartbeatBrowserLease(run.id, WORKER, lease.leaseEpoch, 60));
      expect(await lockWaitBehind(holder.pid, LEASE_KEY)).toMatchObject({ wait_event_type: "Lock", blocked_by_holder: true });
      await holder.session.query("rollback");
      expect(await renewing).toMatchObject({ result: true });
    } finally { await holder.session.end(); }
    expect((await ledger.getBrowserLease(run.id))!.expiresAt.getTime()).toBeGreaterThan(leaseBefore.expiresAt.getTime() + 20_000);
  });

  it("preserveExecutionOwnership (predates 1c183ee6): another session holds the lease row FOR UPDATE and leaves it unchanged while the preservation waits on it; the lease expires during that wait; it refuses and preserves nothing", async () => {
    const { run } = await ownedRun(1);
    const controlBefore = await ledger.getRecoveryControl(run.id);
    const { waitedMs, ...outcome } = await behindLockOnlyHolder("preserve ownership", run.id, RUN_LEASE_LOCK, () => ledger.preserveRecoveryExecutionOwnership(run.id));
    expect({ outcome, control: await ledger.getRecoveryControl(run.id) }).toEqual({ outcome: { rejected: "RECOVERY_LEASE_MISMATCH" }, control: controlBefore });
    expect(waitedMs).toBeLessThan(2_000);
  });

  it("preserveExecutionOwnership control: behind the same lock-only holder, a live lease's ownership is preserved once the holder rolls back", async () => {
    const { run, lease } = await ownedRun(30);
    const holder = await lockOnlyLeaseHolder(run.id);
    try {
      const preserving = settled(ledger.preserveRecoveryExecutionOwnership(run.id));
      expect(await lockWaitBehind(holder.pid, RUN_LEASE_LOCK)).toMatchObject({ wait_event_type: "Lock", blocked_by_holder: true });
      await holder.session.query("rollback");
      expect(await preserving).toMatchObject({ result: { executionOwnership: { workerIdSha256: sha256(WORKER), browserLeaseEpoch: lease.leaseEpoch } } });
    } finally { await holder.session.end(); }
  });

  /**
   * The other interleaving, as its own case (not part of the fix): the holder
   * UPDATES the lease row (expires it) and commits. PostgreSQL re-evaluates a
   * waiting statement's WHERE and output columns against the updated row, so
   * the waiter refuses before and after the fix alike.
   */
  it.each([
    ["the capture append", RUN_LEASE_LOCK.replace(" for update", ""), async (runId: string, epoch: number) => ledger.appendLeaseBoundEvents(runId, { workerId: WORKER, leaseEpoch: epoch }, capture("updated-row"), joinThread("thread-updated-row")), { result: { committed: false } }],
    ["the renewal", LEASE_KEY, async (runId: string, epoch: number) => ledger.heartbeatBrowserLease(runId, WORKER, epoch, 30), { result: false }],
    ["the ownership preservation", RUN_LEASE_LOCK, async (runId: string) => ledger.preserveRecoveryExecutionOwnership(runId), { rejected: "RECOVERY_LEASE_MISMATCH" }],
  ] as const)("updated row, its own case: the holder expires the lease row and commits while %s waits on it; the waiter refuses", async (_label, fragment, work, expected) => {
    const { run, lease } = await ownedRun(30);
    const holder = await holding("update sophia_voice_lab.browser_leases set expires_at=clock_timestamp()-interval '1 second' where run_id=$1", [run.id]);
    const holderPid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    let outcome: Settled = { waitedMs: -1, harnessError: "not settled" };
    try {
      const running = settled(work(run.id, lease.leaseEpoch));
      expect(await lockWaitBehind(holderPid, fragment)).toMatchObject({ wait_event_type: "Lock", blocked_by_holder: true });
      await holder.query("commit");
      outcome = await running;
    } finally { await holder.end(); }
    const { waitedMs: _waited, ...settledAs } = outcome;
    expect(settledAs).toEqual(expected);
    expect(await leaseExpired(run.id)).toBe(true);
  });

  it("in flight, before the linearization point: the lease is released while the append waits for the run row; it then refuses whole", async () => {
    const { run, lease } = await liveRun(ledger);
    const before = await sideEffects(ledger, run.id);
    const holder = await holding("select id from sophia_voice_lab.runs where id=$1 for update", [run.id]);
    try {
      const appending = ledger.appendLeaseBoundEvents(run.id, { workerId: WORKER, leaseEpoch: lease.leaseEpoch }, capture("released-in-flight"), joinThread("thread-in-flight"));
      await blockedOn("from sophia_voice_lab.runs where id=$1 for update");
      expect(await ledger.releaseBrowserLease(run.id, WORKER, lease.leaseEpoch)).toBe(true);
      expect(await ledger.getBrowserLease(run.id)).toBeNull();
      await holder.query("rollback");
      await expect(appending).resolves.toEqual({ committed: false });
    } finally { await holder.end(); }
    expect(await sideEffects(ledger, run.id)).toEqual(before);
  });

  it("in flight, before the linearization point: the lease expires while the append waits for the run row; it then refuses whole", async () => {
    const { run, lease } = await liveRun(ledger, 1);
    const before = await sideEffects(ledger, run.id);
    const holder = await holding("select id from sophia_voice_lab.runs where id=$1 for update", [run.id]);
    try {
      const appending = ledger.appendLeaseBoundEvents(run.id, { workerId: WORKER, leaseEpoch: lease.leaseEpoch }, capture("expired-in-flight"), joinThread("thread-expired-in-flight"));
      await blockedOn("from sophia_voice_lab.runs where id=$1 for update");
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      expect((await admin.query("select expires_at <= clock_timestamp() as expired from sophia_voice_lab.browser_leases where run_id=$1", [run.id])).rows[0].expired).toBe(true);
      await holder.query("rollback");
      await expect(appending).resolves.toEqual({ committed: false });
    } finally { await holder.end(); }
    expect(await sideEffects(ledger, run.id)).toEqual(before);
  });

  it("lock order run -> control -> lease: a settlement-ordered transaction (control FOR UPDATE, then lease FOR UPDATE, no run lock) and a join-bearing capture write serialize without a deadlock", async () => {
    const { run, lease } = await liveRun(ledger);
    const before = await sideEffects(ledger, run.id);
    // PostgresRecoveryControls.settle's statement order, on its own session.
    const settle = await holding("select * from sophia_voice_lab.recovery_controls where run_id=$1 for update", [run.id]);
    let settleError: unknown = null;
    let appendError: unknown = null;
    try {
      const appending = ledger.appendLeaseBoundEvents(run.id, { workerId: WORKER, leaseEpoch: lease.leaseEpoch }, capture("lock-order"), joinThread("thread-lock-order"))
        .catch((error: unknown) => { appendError = error; return null; });
      // The capture write is now waiting for a lock (the control row, or the join's control update before the fix).
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await admin.query("select count(*)::int as n from pg_stat_activity where application_name='sophia-voice-lab' and wait_event_type='Lock'");
        if (waiting.rows[0].n > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await settle.query("set local lock_timeout = '4s'");
      await settle.query("select worker_id,lease_epoch from sophia_voice_lab.browser_leases where run_id=$1 for update", [run.id]).catch((error: unknown) => { settleError = error; });
      await settle.query(settleError === null ? "commit" : "rollback");
      const appended = await appending;
      expect({ settle: (settleError as { code?: string } | null)?.code ?? null, append: (appendError as { code?: string } | null)?.code ?? null }).toEqual({ settle: null, append: null });
      expect(appended).toEqual({ committed: true, appended: 2 });
    } finally { await settle.end(); }
    expect(await sideEffects(ledger, run.id)).toEqual({ cursor: before.cursor + 2, version: before.version + 1, threadId: "thread-lock-order", captured: 2 });
  });

  it("after the linearization point: a release issued while the append is in flight waits for it, so the append wins entirely before the release", async () => {
    const { run, lease } = await liveRun(ledger);
    const before = await sideEffects(ledger, run.id);
    // A test-only trigger on this dedicated database pauses the capture insert, which runs after the lease lock.
    await admin.query(`create or replace function sophia_voice_lab.capture_test_pause() returns trigger language plpgsql as $$
      begin if new.payload->>'pause' = 'true' then perform pg_sleep(1.2); end if; return new; end $$`);
    await admin.query("create trigger capture_test_pause before insert on sophia_voice_lab.run_events for each row execute function sophia_voice_lab.capture_test_pause()");
    const order: string[] = [];
    try {
      const batch = capture("after-point").map((input, index) => index === 0 ? { ...input, payload: { ...input.payload, pause: true } } : input);
      const appending = ledger.appendLeaseBoundEvents(run.id, { workerId: WORKER, leaseEpoch: lease.leaseEpoch }, batch, joinThread("thread-after-point")).then((result) => { order.push("append"); return result; });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const sleeping = await admin.query("select count(*)::int as n from pg_stat_activity where application_name='sophia-voice-lab' and wait_event='PgSleep'");
        if (sleeping.rows[0].n > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const releasing = ledger.releaseBrowserLease(run.id, WORKER, lease.leaseEpoch).then((released) => { order.push("release"); return released; });
      await blockedOn("delete from sophia_voice_lab.browser_leases");
      expect(order).toEqual([]);
      await expect(appending).resolves.toEqual({ committed: true, appended: 2 });
      await expect(releasing).resolves.toBe(true);
    } finally {
      await admin.query("drop trigger if exists capture_test_pause on sophia_voice_lab.run_events");
      await admin.query("drop function if exists sophia_voice_lab.capture_test_pause()");
    }
    expect(order).toEqual(["append", "release"]);
    expect(await sideEffects(ledger, run.id)).toEqual({ cursor: before.cursor + 2, version: before.version + 1, threadId: "thread-after-point", captured: 2 });
    expect(await ledger.getBrowserLease(run.id)).toBeNull();
  });
});
