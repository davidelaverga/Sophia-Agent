import type { VoiceLabConfig } from "./config.js";
import type { RecoveryControlRecord } from "./recovery-control.js";
import { RecoveryControlBindingSchema } from "./recovery-control.js";
import { parseD02RecoveryJournal } from "./d02-recovery-journal.js";
import { parseExecutionOwnership } from "./execution-ownership.js";
import { parseRetainedOwnerDeath } from "./retained-owner-death.js";
import { D02GatewaySettlementReadbackRequestSchema, verifyD02GatewaySettlementSignature } from "./d02-gateway.js";
import { canonicalRequestHash, sha256 } from "./security.js";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const proofCore = z.object({ schema: z.literal("sophia.voice-lab.retained-d02-provider-settlement.v1"),
  ownerDeathProofSha256: digest, gatewayReceiptSha256: digest, gatewayAuthorityKeyId: z.string().min(8).max(128),
  gatewayAuthorityPublicKeySha256: digest, providerSettlementSha256: digest,
  observedAt: z.string().datetime().refine(v => new Date(v).toISOString() === v),
  providerCleanupProven: z.literal(true), authCleanupProven: z.literal(false),
  builderCleanupProven: z.literal(false), liveResourcesZeroProven: z.literal(false),
}).strict();
export type RetainedD02ProviderSettlement = z.infer<typeof proofCore> & { proofSha256: string };
/** Storage integrity only; ingestion separately verifies the signed Gateway. */
export function parseRetainedD02ProviderSettlement(input: unknown): RetainedD02ProviderSettlement {
  const { proofSha256, ...core } = z.object({ proofSha256: digest }).passthrough().parse(input);
  const parsed = proofCore.parse(core);
  if (canonicalRequestHash(parsed) !== proofSha256) throw new Error("D02_PROVIDER_PROOF_DIGEST_INVALID");
  return { ...parsed, proofSha256 };
}

/** Match the existing signed Gateway provider settlement to retained authority.
 * No raw run/events required. This does not prove auth/Builder cleanup and is
 * not a lease-release or overall-settlement grant. */
export function verifyRetainedD02ProviderSettlement(control: RecoveryControlRecord, rawReceipt: unknown,
  authority: VoiceLabConfig["d02GatewayReceiptAuthority"], observedAt: Date) {
  const { binding, journal, owner } = retainedD02Authority(control);
  const receipt = verifyD02GatewaySettlementSignature(rawReceipt, authority, observedAt);
  return verifyBoundRetainedProvider(control, receipt, authority, binding, journal, owner);
}

function retainedD02Authority(control: RecoveryControlRecord) {
  const binding = RecoveryControlBindingSchema.parse(control.binding);
  const journal = parseD02RecoveryJournal(control.d02Journal);
  const owner = parseRetainedOwnerDeath(control.d02OwnerDeath);
  const execution = parseExecutionOwnership(control.executionOwnership);
  if (binding.scenarioId !== "V-D02" || !control.browserAllocationEver
    || owner.controlBindingSha256 !== canonicalRequestHash(binding)
    || owner.dispatchJournalProofSha256 !== journal.proofSha256
    || owner.ownershipProofSha256 !== execution.proofSha256) throw new Error("RETAINED_D02_AUTHORITY_MISMATCH");
  return { binding, journal, owner };
}

/** Derive only from retained acquisition, dispatch and independently verified
 * owner authority. No original provider/session identifier is needed or guessed. */
export function deriveRetainedD02SettlementLookup(control: RecoveryControlRecord) {
  const { binding, journal, owner } = retainedD02Authority(control);
  return D02GatewaySettlementReadbackRequestSchema.parse({
    schema: "sophia_voice_lab_gateway_browser_worker_termination_receipt_lookup_v1",
    cleanup_obligation_id: binding.cleanupObligationId,
    termination_request_id_sha256: journal.terminationRequestIdSha256,
    voice_lab_run_id_sha256: sha256(binding.runId), test_run_id_sha256: sha256(binding.testRunId),
    provider_session_id_sha256: journal.providerSessionIdSha256, provider_admission_id_sha256: journal.providerAdmissionIdSha256,
    provider_connection_epoch: journal.providerConnectionEpoch, frozen_provider_connection_epochs: journal.frozenProviderConnectionEpochs,
    browser_worker_id_sha256: journal.workerIdSha256, browser_lease_epoch: journal.browserLeaseEpoch,
    browser_context_id_sha256: journal.browserContextIdSha256, render_action_request_sha256: journal.actionRequestSha256,
    render_action_accepted_response_sha256: owner.actionAcceptedResponseSha256,
    render_action_settled_snapshot_sha256: owner.actionSettledSnapshotSha256,
    loss_event_seq: owner.lossEventSeq, loss_observed_at: owner.lossObservedAt,
  });
}

function verifyBoundRetainedProvider(control: RecoveryControlRecord,
  receipt: ReturnType<typeof verifyD02GatewaySettlementSignature>, authority: VoiceLabConfig["d02GatewayReceiptAuthority"],
  binding: ReturnType<typeof retainedD02Authority>["binding"], journal: ReturnType<typeof retainedD02Authority>["journal"],
  owner: ReturnType<typeof retainedD02Authority>["owner"]) {
  if (receipt.voice_lab_run_id_sha256 !== sha256(binding.runId)
    || receipt.test_run_id_sha256 !== sha256(binding.testRunId)
    || receipt.cleanup_obligation_id_sha256 !== sha256(binding.cleanupObligationId)
    || receipt.scenario_id !== binding.scenarioId || receipt.scenario_version !== binding.scenarioVersion
    || receipt.environment !== binding.environment
    || canonicalRequestHash(receipt.expected_deployment) !== canonicalRequestHash(binding.expectedDeployment)
    || receipt.termination_request_id_sha256 !== journal.terminationRequestIdSha256
    || receipt.provider_session_id_sha256 !== journal.providerSessionIdSha256
    || receipt.provider_admission_id_sha256 !== journal.providerAdmissionIdSha256
    || receipt.provider_connection_epoch !== journal.providerConnectionEpoch
    || canonicalRequestHash(receipt.frozen_provider_connection_epochs) !== canonicalRequestHash(journal.frozenProviderConnectionEpochs)
    || receipt.browser_worker_id_sha256 !== journal.workerIdSha256
    || receipt.browser_lease_epoch !== journal.browserLeaseEpoch
    || receipt.browser_context_id_sha256 !== journal.browserContextIdSha256
    || receipt.render_action_request_sha256 !== journal.actionRequestSha256
    || receipt.render_action_accepted_response_sha256 !== owner.actionAcceptedResponseSha256
    || receipt.render_action_settled_snapshot_sha256 !== owner.actionSettledSnapshotSha256
    || receipt.loss_event_seq !== owner.lossEventSeq || receipt.loss_observed_at !== owner.lossObservedAt
    || receipt.cleanup_obligation_state !== "closed"
    || Date.parse(receipt.database_observed_at) < Math.max(Date.parse(owner.settledAt), Date.parse(owner.lossObservedAt))) throw new Error("RETAINED_D02_PROVIDER_BINDING_MISMATCH");
  const proof = { schema: "sophia.voice-lab.retained-d02-provider-settlement.v1" as const,
    ownerDeathProofSha256: owner.proofSha256, gatewayReceiptSha256: canonicalRequestHash(receipt),
    gatewayAuthorityKeyId: receipt.authority_key_id,
    gatewayAuthorityPublicKeySha256: sha256(Buffer.from(authority!.publicKeysById[receipt.authority_key_id]!, "base64")),
    providerSettlementSha256: receipt.provider_settlement_sha256, observedAt: receipt.database_observed_at,
    providerCleanupProven: true as const, authCleanupProven: false as const,
    builderCleanupProven: false as const, liveResourcesZeroProven: false as const };
  return parseRetainedD02ProviderSettlement({ ...proof, proofSha256: canonicalRequestHash(proof) });
}
