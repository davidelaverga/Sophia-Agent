import { z } from "zod";
import type { LabEvent, RunRecord } from "./domain.js";
import { canonicalRequestHash, sha256 } from "./security.js";

export const D02_DISPATCH_EVENT = "product.d02_render_worker_dispatch_claimed";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const seq = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const coreSchema = z.object({
  schema: z.literal("sophia.voice-lab.d02-recovery-journal.v1"),
  runIdSha256: hash, cleanupObligationIdSha256: hash,
  terminationRequestIdSha256: hash, commandContentSha256: hash, commandEventSeq: seq,
  gatewayFreezeRequestSha256: hash, gatewayFreezeEventSeq: seq,
  dispatchClaimSha256: hash, dispatchClaimEventSeq: seq,
  providerSessionIdSha256: hash, providerAdmissionIdSha256: hash, providerConnectionEpoch: seq,
  frozenProviderConnectionEpochs: z.array(seq).min(1).max(64),
  workerIdSha256: hash, browserLeaseEpoch: seq, browserContextIdSha256: hash,
  workerServiceIdSha256: hash, actionRequestSha256: hash, dispatchAttemptIdSha256: hash,
}).strict().superRefine((v, ctx) => {
  if (v.commandEventSeq >= v.dispatchClaimEventSeq || v.gatewayFreezeEventSeq >= v.dispatchClaimEventSeq
    || !v.frozenProviderConnectionEpochs.includes(v.providerConnectionEpoch)
    || v.frozenProviderConnectionEpochs.some((epoch, index, all) => index > 0 && epoch <= all[index - 1]!)) ctx.addIssue({ code: "custom", message: "D02 journal sequence/epoch order invalid" });
});
export type D02RecoveryJournal = z.infer<typeof coreSchema> & { proofSha256: string };
export function parseD02RecoveryJournal(input: unknown): D02RecoveryJournal {
  const { proofSha256, ...core } = z.object({ proofSha256: hash }).passthrough().parse(input);
  const parsed = coreSchema.parse(core);
  if (canonicalRequestHash(parsed) !== proofSha256) throw new Error("D02_JOURNAL_DIGEST_INVALID");
  return { ...parsed, proofSha256 };
}

/** Metadata projection inside the owning claim transaction, AFTER its existing
 * complete snapshot guard. This does not replace signature, freeze or CAS checks. */
export function deriveD02RecoveryJournal(run: RunRecord, events: LabEvent[], dispatch: LabEvent): D02RecoveryJournal {
  const fail = () => { throw new Error("D02_JOURNAL_BINDING_INVALID"); };
  const d = dispatch.payload;
  if (run.scenarioId !== "V-D02" || dispatch.kind !== D02_DISPATCH_EVENT || dispatch.source !== "canonical" || dispatch.runId !== run.id) fail();
  const command = events.find(e => e.seq === d.command_event_seq);
  const freezes = events.filter(e => e.kind === "product.d02_gateway_browser_worker_termination_frozen");
  if (!command || freezes.length !== 1) return fail();
  const freeze = freezes[0]!;
  const c = z.record(z.string(), z.unknown()).parse(command.payload.evidence);
  const f = freeze.payload;
  const commandCore = { ...command.payload }; delete commandCore.content_sha256;
  const dispatchCore = { ...d }; delete dispatchCore.dispatch_claim_sha256;
  if (command.runId !== run.id || freeze.runId !== run.id || command.source !== "canonical" || freeze.source !== "canonical"
    || command.kind !== "external.attestation.d02_browser_worker_termination_command"
    || command.payload.binding_validated !== true || command.payload.content_sha256 !== canonicalRequestHash(commandCore)
    || command.payload.content_sha256 !== d.command_content_sha256
    || c.kind !== "d02_browser_worker_termination_command" || c.run_id_sha256 !== sha256(run.id)
    || c.cleanup_obligation_id_sha256 !== sha256(run.cleanupObligationId)
    || sha256(String(c.termination_request_id)) !== d.termination_request_id_sha256
    || c.worker_service_id_sha256 !== d.worker_service_id_sha256 || c.render_action_request_sha256 !== d.action_request_sha256
    || d.dispatch_claim_sha256 !== canonicalRequestHash(dispatchCore)
    || f.gateway_frozen !== true || f.voice_lab_run_id_sha256 !== sha256(run.id)
    || f.cleanup_obligation_id_sha256 !== sha256(run.cleanupObligationId)
    || f.termination_request_id_sha256 !== d.termination_request_id_sha256
    || f.render_action_request_sha256 !== d.action_request_sha256) fail();
  for (const key of ["provider_session_id_sha256", "provider_admission_id_sha256", "provider_connection_epoch", "frozen_provider_connection_epochs", "browser_worker_id_sha256", "browser_lease_epoch", "browser_context_id_sha256"]) {
    if (canonicalRequestHash(c[key]) !== canonicalRequestHash(f[key])) fail();
  }
  const core = coreSchema.parse({
    schema: "sophia.voice-lab.d02-recovery-journal.v1", runIdSha256: sha256(run.id), cleanupObligationIdSha256: sha256(run.cleanupObligationId),
    terminationRequestIdSha256: d.termination_request_id_sha256, commandContentSha256: d.command_content_sha256, commandEventSeq: command.seq,
    gatewayFreezeRequestSha256: f.freeze_request_sha256, gatewayFreezeEventSeq: freeze.seq,
    dispatchClaimSha256: d.dispatch_claim_sha256, dispatchClaimEventSeq: dispatch.seq,
    providerSessionIdSha256: c.provider_session_id_sha256, providerAdmissionIdSha256: c.provider_admission_id_sha256,
    providerConnectionEpoch: c.provider_connection_epoch, frozenProviderConnectionEpochs: c.frozen_provider_connection_epochs,
    workerIdSha256: c.browser_worker_id_sha256, browserLeaseEpoch: c.browser_lease_epoch, browserContextIdSha256: c.browser_context_id_sha256,
    workerServiceIdSha256: d.worker_service_id_sha256, actionRequestSha256: d.action_request_sha256, dispatchAttemptIdSha256: d.dispatch_attempt_id_sha256,
  });
  return { ...core, proofSha256: canonicalRequestHash(core) };
}
