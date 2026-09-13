import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { VoiceLabLedger } from "../src/ledger.js";
import { canonicalRequestHash, sha256 } from "../src/security.js";
import { D02_DISPATCH_EVENT } from "../src/d02-recovery-journal.js";
import { testRun } from "./helpers.js";

/** Adapter atomicity fixture only; the service test supplies the real D02
 * authorization/freeze guard. No browser or provider is allocated here. */
export async function verifyD02JournalDurability(ledger: VoiceLabLedger, rollbackProbe?: (claim: () => Promise<unknown>, runId: string) => Promise<void>) {
  const run = testRun({ scenarioId: "V-D02", state: "failed_harness" });
  await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 100, caller: 100 });
  const termination = randomUUID();
  const common = { provider_session_id_sha256: sha256("provider"), provider_admission_id_sha256: sha256("admission"), provider_connection_epoch: 2,
    frozen_provider_connection_epochs: [1, 2], browser_worker_id_sha256: sha256("worker"), browser_lease_epoch: 1, browser_context_id_sha256: sha256("context") };
  const commandCore = { binding_validated: true, evidence: { ...common, kind: "d02_browser_worker_termination_command",
    run_id_sha256: sha256(run.id), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), termination_request_id: termination,
    worker_service_id_sha256: sha256("service"), render_action_request_sha256: sha256("action") } };
  const commandHash = canonicalRequestHash(commandCore);
  const command = await ledger.appendEvent(run.id, "external.attestation.d02_browser_worker_termination_command", "canonical", { ...commandCore, content_sha256: commandHash });
  const freeze = await ledger.appendEvent(run.id, "product.d02_gateway_browser_worker_termination_frozen", "canonical", { ...common,
    gateway_frozen: true, voice_lab_run_id_sha256: sha256(run.id), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
    termination_request_id_sha256: sha256(termination), render_action_request_sha256: sha256("action"), freeze_request_sha256: sha256("freeze"), ignored_content: "MUST_NOT_RETAIN" });
  const core = { schema: "sophia_voice_lab_d02_render_worker_dispatch_claim_v1", termination_request_id_sha256: sha256(termination),
    command_content_sha256: commandHash, command_event_seq: command.seq, command_attestation_id_sha256: sha256("attestation"),
    worker_service_id_sha256: sha256("service"), action_request_sha256: sha256("action"), dispatch_attempt_id_sha256: sha256("attempt"),
    requested_at: new Date().toISOString(), raw_action_and_attempt_identifiers_excluded: true };
  const payload = { ...core, dispatch_claim_sha256: canonicalRequestHash(core) };
  const key = `d02-render-dispatch:${sha256(termination)}`;
  await expect(ledger.claimEvent(run.id, D02_DISPATCH_EVENT, "canonical", payload, key, new Date(), () => { throw new Error("guard failed"); })).rejects.toThrow("guard failed");
  expect((await ledger.getRecoveryControl(run.id))!.d02Journal).toBeUndefined();
  expect((await ledger.getRun(run.id))!.latestCursor).toBe(freeze.seq);
  let guards = 0;
  const claim = () => ledger.claimEvent(run.id, D02_DISPATCH_EVENT, "canonical", payload, key, new Date(), snapshot => {
    guards++;
    expect(snapshot.events.map(e => e.seq)).toEqual([command.seq, freeze.seq]);
  });
  if (rollbackProbe) {
    const before = await ledger.getRecoveryControl(run.id);
    await rollbackProbe(claim, run.id);
    expect(await ledger.getRecoveryControl(run.id)).toEqual(before);
    expect((await ledger.getRun(run.id))!.latestCursor).toBe(freeze.seq);
    guards = 0;
  }
  const results = await Promise.all([claim(), claim()]);
  expect(results.filter(r => r.replay)).toHaveLength(1);
  expect(guards).toBe(1);
  const journal = (await ledger.getRecoveryControl(run.id))!.d02Journal!;
  expect(journal).toMatchObject({ dispatchClaimSha256: payload.dispatch_claim_sha256, gatewayFreezeEventSeq: freeze.seq, dispatchClaimEventSeq: freeze.seq + 1 });
  expect(JSON.stringify(journal)).not.toContain("MUST_NOT_RETAIN");
  await expect(ledger.claimEvent(run.id, D02_DISPATCH_EVENT, "canonical", { ...payload, dispatch_attempt_id_sha256: sha256("other") }, key, new Date(), () => {})).rejects.toThrow();
  const current = (await ledger.getRun(run.id))!;
  const now = new Date();
  await ledger.updateRun(run.id, current.version, { retentionPurgeDueAt: new Date(now.getTime() - 1), retentionPurgePending: true });
  await ledger.purgeExpiredRetention(now, 100);
  expect(await ledger.getRun(run.id)).toBeNull();
  expect((await ledger.getRecoveryControl(run.id))!.d02Journal).toEqual(journal);
  const retained = (await ledger.getRecoveryControl(run.id))!;
  await ledger.settleRecoveryControl(run.id, retained.version, { kind: "cleanup.recovery", source: "canonical", payload: { complete: true, http_status: 200, retention_purged: true,
    receipt: { test_run_id: run.testRunId, cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), complete: true, live_cleanup_complete: true, live_resources_zero: true,
      retention_purged: true, retention_purge_pending: false, retention_maintenance_complete: true,
      components: { canonical_session: { status: "not_found" }, voice_provider: { status: "not_found" }, auth_sessions: { status: "not_found" },
        builder: { status: "completed", cleanup_complete: true, discovery_complete: true, authoritative_zero_tasks: true, discovered_task_count: 0 } },
      receipt: { storage: "postgres", object_path: "synthetic/receipt", sha256: sha256("zero-resource-fixture") } } } });
}
