import { createHash } from "node:crypto";

import { z } from "zod";

/**
 * Studio G7 adapter contract (`sophia.studio-g7.v1`).
 *
 * This module is the Lab-side reading of the product contract
 * `sophia.voice-qualification.v1` (docs/plans/voice-qualification-g7.md in the
 * Studio repository). Every product receipt is parsed with a strict schema:
 * unknown keys are rejected and no free-text string is accepted. Strings are
 * only UUIDs, hex digests, enumerated words, bounded identifiers or ISO
 * timestamps. A receipt that fails these schemas is never evidence.
 */

export const LEGACY_TARGET_KIND = "legacy-gemini-browser-v1" as const;
export const STUDIO_G7_TARGET_KIND = "studio-livekit-g7-v1" as const;
export const TARGET_KINDS = [LEGACY_TARGET_KIND, STUDIO_G7_TARGET_KIND] as const;
export type TargetKind = typeof TARGET_KINDS[number];

/** The Lab's scenario/target contract version for this adapter. */
export const STUDIO_G7_CONTRACT_VERSION = "sophia.studio-g7.v1" as const;
/** The product contract this adapter reads. */
export const STUDIO_G7_PRODUCT_CONTRACT = "sophia.voice-qualification.v1" as const;
export const STUDIO_PAGE_RECEIPT_SCHEMA = "sophia.studio.voice_qualification.v1" as const;
export const STUDIO_PAGE_RECEIPT_EVENT = "sophia:voice-qualification" as const;
export const STUDIO_G7_EVALUATION_SCHEMA = "sophia.voice-lab.studio-g7.evaluation.v1" as const;
export const STUDIO_RUN_BINDING_SCHEMA = "sophia.voice-lab.studio-g7.run-binding.v1" as const;
export const PCM_DIGEST_ALGORITHM = "sha-256-chain-v1" as const;

// ---------------------------------------------------------------------------
// Run binding
// ---------------------------------------------------------------------------

export interface RunBindingInput {
  testRunId: string;
  cleanupObligationId: string;
  scenarioId: string;
  scenarioVersion: string;
}

const BINDING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BINDING_SCENARIO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Canonical JSON for the run binding. The object has exactly five ASCII keys
 * in lexicographic order and no whitespace:
 *
 *   {"cleanup_obligation_id":"<uuid>","scenario_id":"<id>","scenario_version":"<version>",
 *    "schema":"sophia.voice-lab.studio-g7.run-binding.v1","test_run_id":"<uuid>"}
 *
 * UUIDs are lowercase canonical form. The binding hash is the lowercase hex
 * SHA-256 of the UTF-8 bytes of that string. It is the value an operator
 * passes as `run_binding_sha256` to `sophia.voice_qualification_grant(...)`.
 * It is not secret, and the product never sees what it hashes; the raw
 * cleanup obligation id never leaves the Lab.
 */
export function canonicalRunBindingJson(input: RunBindingInput): string {
  const testRunId = input.testRunId.toLowerCase();
  const cleanupObligationId = input.cleanupObligationId.toLowerCase();
  if (!BINDING_UUID.test(testRunId) || !BINDING_UUID.test(cleanupObligationId)
    || !BINDING_SCENARIO.test(input.scenarioId) || !BINDING_SCENARIO.test(input.scenarioVersion)) {
    throw new Error("Run binding inputs must be canonical UUIDs and bounded scenario identifiers.");
  }
  return `{"cleanup_obligation_id":${JSON.stringify(cleanupObligationId)},"scenario_id":${JSON.stringify(input.scenarioId)},"scenario_version":${JSON.stringify(input.scenarioVersion)},"schema":${JSON.stringify(STUDIO_RUN_BINDING_SCHEMA)},"test_run_id":${JSON.stringify(testRunId)}}`;
}

export function computeRunBindingSha256(input: RunBindingInput): string {
  return createHash("sha256").update(canonicalRunBindingJson(input), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Primitive schemas (no free text)
// ---------------------------------------------------------------------------

export const UuidSchema = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "expected a UUID");
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase SHA-256 hex digest");
export const Commit40Schema = z.string().regex(/^[0-9a-f]{40}$/, "expected a 40-hex commit");
/** Epoch milliseconds. */
export const EpochMsSchema = z.number().int().nonnegative().max(8_640_000_000_000_000);
export const IsoTimestampSchema = z.string().datetime({ offset: true });
export const CountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const OrdinalSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const LevelSchema = z.number().finite().nonnegative().max(1_000_000);
/** LiveKit track SIDs (e.g. `TR_AMkxyz...`): fixed prefix plus base62 body. */
export const TrackSidSchema = z.string().regex(/^TR_[A-Za-z0-9]{4,64}$/, "expected a LiveKit track SID");
/** `MediaStreamTrack.id`: a UUID, optionally brace-wrapped (Firefox). */
export const MediaTrackIdSchema = z.string().regex(/^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/, "expected a MediaStreamTrack id");
/** Provider model identifier, an enumerated product configuration word. */
export const ModelIdSchema = z.string().regex(/^(?:models\/)?gemini-[a-z0-9.-]{1,120}$/, "expected a Gemini model identifier");

// ---------------------------------------------------------------------------
// Studio page receipts (window CustomEvent 'sophia:voice-qualification')
// ---------------------------------------------------------------------------

const PageBase = {
  schema: z.literal(STUDIO_PAGE_RECEIPT_SCHEMA),
  grantId: UuidSchema,
  runBindingSha256: Sha256HexSchema,
  atMs: EpochMsSchema,
};

export const PLAYBACK_PHASES = ["play", "playing", "pause", "waiting", "ended", "emptied"] as const;

export const MicPublishedPageReceiptSchema = z.object({ ...PageBase, event: z.literal("mic_published"), trackSid: TrackSidSchema, trackId: MediaTrackIdSchema }).strict();
export const MicUnpublishedPageReceiptSchema = z.object({ ...PageBase, event: z.literal("mic_unpublished"), trackSid: TrackSidSchema }).strict();
export const SophiaPlaybackPageReceiptSchema = z.object({ ...PageBase, event: z.literal("sophia_playback"), phase: z.enum(PLAYBACK_PHASES), trackSid: TrackSidSchema, mediaTimeMs: z.number().finite().nonnegative().max(86_400_000) }).strict();
export const StudioPageReceiptSchema = z.discriminatedUnion("event", [MicPublishedPageReceiptSchema, MicUnpublishedPageReceiptSchema, SophiaPlaybackPageReceiptSchema]);
export type StudioPageReceipt = z.infer<typeof StudioPageReceiptSchema>;

// ---------------------------------------------------------------------------
// Bridge and service receipts (read through
// GET /api/v1/exchanges/{id}/qualification-evidence, which returns
// `sophia.voice_qualification_evidence_read(exchange)` of migration 0046).
//
// Shapes follow the migration, which is authoritative where the plan document
// differs (see STUDIO_G7_CONTRACT_DIFFERENCES):
// - one `grant` object, not a `grants` array;
// - every row carries `source` ('bridge' | 'service') and `seq` 0..99999,
//   ordered by source then seq; `(source = 'service') = (kind = 'guard')`;
// - every receipt body carries its own `kind` (the database refuses a body
//   whose kind differs from the row's);
// - the guard body is written by the database:
//   {kind, schema:'sophia.service.guard.v1', grantId, runBindingSha256, reason, atMs}
//   with no seq, always at service seq 0;
// - the guard has six reasons (the plan lists five; `turns` is the sixth);
// - provider receipts may carry the counters the guard holds to the limits:
//   connectionsOpened, turns, usageTokens, lastPromptTokens.
// ---------------------------------------------------------------------------

export const BRIDGE_RECEIPT_KINDS = ["input_window", "input_turn", "provider", "output_reply", "session_closed", "guard"] as const;
export type BridgeReceiptKind = typeof BRIDGE_RECEIPT_KINDS[number];
export const EVIDENCE_SOURCES = ["bridge", "service"] as const;
export type EvidenceSource = typeof EVIDENCE_SOURCES[number];
export const INPUT_WINDOW_END_REASONS = ["turn_complete", "interrupted", "handoff", "paused", "closed", "deadline"] as const;
export const INPUT_TURN_OUTCOMES = ["answered", "no_user_turn_observed", "interrupted", "connection_lost"] as const;
export const PROVIDER_PHASES = ["setup", "ready", "recovering", "unavailable", "closed", "usage"] as const;
export const OUTPUT_REPLY_TERMINALS = ["played", "stopped", "interrupted", "recovered", "closed"] as const;
export const SESSION_CLOSED_REASONS = ["ended", "lost", "guard"] as const;
/** Migration 0046 `ended_reason` / guard reasons (six; the plan lists five). */
export const GUARD_REASONS = ["deadline", "expired", "revoked", "connections", "turns", "usage"] as const;
export type GuardReason = typeof GUARD_REASONS[number];
export const GUARD_RECEIPT_SCHEMA = "sophia.service.guard.v1" as const;
/** Exchange states the evidence read reports (`room_exchanges.state`). */
export const EXCHANGE_STATES = ["open", "paused", "ended"] as const;
export const EVIDENCE_SEQ_MAX = 99_999;
export const EvidenceSeqSchema = z.number().int().min(0).max(EVIDENCE_SEQ_MAX);

function bridgeReceipt<K extends Exclude<BridgeReceiptKind, "guard">, S extends z.ZodRawShape>(kind: K, shape: S) {
  return z.object({
    kind: z.literal(kind),
    // The product's own tests label bridge bodies `sophia.bridge.<kind>.v1`;
    // the plan does not name a schema field, so it is optional but exact.
    schema: z.literal(`sophia.bridge.${kind}.v1`).optional(),
    grantId: UuidSchema,
    runBindingSha256: Sha256HexSchema,
    // The plan lists `seq` among the body fields; the migration keys the row
    // by seq and its tests omit it from the body. Optional, and when present
    // it must equal the row's seq.
    seq: EvidenceSeqSchema.optional(),
    atMs: EpochMsSchema,
    ...shape,
  }).strict();
}

const ProviderSessionSchema = UuidSchema;
const ConnectionSchema = z.number().int().positive().max(64);

export const InputWindowReceiptSchema = bridgeReceipt("input_window", {
  windowSeq: OrdinalSchema,
  inputEpoch: CountSchema,
  providerSession: ProviderSessionSchema,
  connection: ConnectionSchema,
  startedAtMs: EpochMsSchema,
  endedAtMs: EpochMsSchema,
  endReason: z.enum(INPUT_WINDOW_END_REASONS),
  chunkCount: CountSchema,
  sampleCount: CountSchema,
  nonzeroSampleCount: CountSchema,
  audibleChunkCount: CountSchema,
  rms: LevelSchema,
  peak: LevelSchema,
  droppedSamples: CountSchema,
  sampleRate: z.literal(16_000),
  pcmDigestAlgorithm: z.literal(PCM_DIGEST_ALGORITHM),
  pcmSha256Chain: Sha256HexSchema,
  rawAudioExcluded: z.literal(true),
});
export const InputTurnReceiptSchema = bridgeReceipt("input_turn", {
  windowSeq: OrdinalSchema,
  turnOrdinal: OrdinalSchema,
  inputTranscriptionObserved: z.boolean(),
  /** A count only; never text and never a hash of text. */
  transcriptChars: CountSchema,
  finished: z.boolean(),
  attributedToHolder: z.boolean(),
  modelResponded: z.boolean(),
  toolCallCount: CountSchema,
  outcome: z.enum(INPUT_TURN_OUTCOMES),
});
export const ProviderReceiptSchema = bridgeReceipt("provider", {
  phase: z.enum(PROVIDER_PHASES),
  providerSession: ProviderSessionSchema,
  connection: ConnectionSchema,
  resumed: z.boolean(),
  model: ModelIdSchema,
  instructionSha256: Sha256HexSchema,
  bridgeCommit: Commit40Schema.nullable(),
  usageTokens: CountSchema.nullable(),
  // Migration 0046: the counters `media_record_evidence` holds to the grant.
  connectionsOpened: CountSchema.optional(),
  turns: CountSchema.optional(),
  lastPromptTokens: CountSchema.optional(),
});
export const OutputReplyReceiptSchema = bridgeReceipt("output_reply", {
  replyOrdinal: OrdinalSchema,
  turnOrdinal: OrdinalSchema.nullable(),
  providerSession: ProviderSessionSchema,
  connection: ConnectionSchema,
  receivedAtMs: EpochMsSchema,
  firstPlayedAtMs: EpochMsSchema.nullable(),
  endedAtMs: EpochMsSchema,
  terminal: z.enum(OUTPUT_REPLY_TERMINALS),
  samplesReceived: CountSchema,
  framesPlayed: CountSchema,
  nonSilentFramesPlayed: CountSchema,
  rms: LevelSchema,
  peak: LevelSchema,
  durationMs: CountSchema,
  playedDigestAlgorithm: z.literal(PCM_DIGEST_ALGORITHM),
  playedSha256Chain: Sha256HexSchema,
});
export const SessionClosedReceiptSchema = bridgeReceipt("session_closed", {
  providerClosed: z.boolean(),
  windows: CountSchema,
  turns: CountSchema,
  replies: CountSchema,
  toolCalls: CountSchema,
  typedMessages: CountSchema,
  transcriptRetained: z.literal(false),
  reason: z.enum(SESSION_CLOSED_REASONS),
});
/** Written by `sophia.voice_qualification_guard()` itself (service seq 0). */
export const GuardReceiptSchema = z.object({
  kind: z.literal("guard"),
  schema: z.literal(GUARD_RECEIPT_SCHEMA),
  grantId: UuidSchema,
  runBindingSha256: Sha256HexSchema,
  reason: z.enum(GUARD_REASONS),
  atMs: EpochMsSchema,
}).strict();

export const BRIDGE_RECEIPT_SCHEMAS = {
  input_window: InputWindowReceiptSchema,
  input_turn: InputTurnReceiptSchema,
  provider: ProviderReceiptSchema,
  output_reply: OutputReplyReceiptSchema,
  session_closed: SessionClosedReceiptSchema,
  guard: GuardReceiptSchema,
} as const;

export type InputWindowReceipt = z.infer<typeof InputWindowReceiptSchema>;
export type InputTurnReceipt = z.infer<typeof InputTurnReceiptSchema>;
export type ProviderReceipt = z.infer<typeof ProviderReceiptSchema>;
export type OutputReplyReceipt = z.infer<typeof OutputReplyReceiptSchema>;
export type SessionClosedReceipt = z.infer<typeof SessionClosedReceiptSchema>;
export type GuardReceipt = z.infer<typeof GuardReceiptSchema>;
export type BridgeReceiptBody = InputWindowReceipt | InputTurnReceipt | ProviderReceipt | OutputReplyReceipt | SessionClosedReceipt | GuardReceipt;

/** The `grant` object of `voice_qualification_evidence_read` (0046). */
export const EvidenceGrantSchema = z.object({
  grantId: UuidSchema,
  runBindingSha256: Sha256HexSchema,
  deadline: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  revokedAt: IsoTimestampSchema.nullable(),
  maxExchangeSeconds: z.number().int().min(60).max(1_800),
  maxProviderConnections: z.number().int().min(1).max(10),
  maxTurns: z.number().int().min(1).max(200),
  maxOutputTokensPerTurn: z.number().int().min(64).max(8_192),
  maxUsageTokens: z.number().int().min(1_000).max(5_000_000),
  connectionsOpened: CountSchema,
  turns: CountSchema,
  usageTokens: CountSchema,
  lastPromptTokens: CountSchema,
  endedReason: z.enum(GUARD_REASONS).nullable(),
}).strict();
export type EvidenceGrant = z.infer<typeof EvidenceGrantSchema>;

const EnvelopeReceiptBase = z.object({
  source: z.enum(EVIDENCE_SOURCES),
  seq: EvidenceSeqSchema,
  kind: z.enum(BRIDGE_RECEIPT_KINDS),
  receivedAt: IsoTimestampSchema,
  receipt: z.record(z.string(), z.unknown()),
}).strict();

export const QualificationEvidenceEnvelopeSchema = z.object({
  exchangeId: UuidSchema,
  state: z.enum(EXCHANGE_STATES),
  grant: EvidenceGrantSchema,
  receipts: z.array(EnvelopeReceiptBase).max(10_000),
}).strict();

export interface ParsedBridgeReceipt {
  source: EvidenceSource;
  seq: number;
  kind: BridgeReceiptKind;
  receivedAt: string;
  receipt: BridgeReceiptBody;
}

export interface ParsedQualificationEvidence {
  exchangeId: string;
  state: typeof EXCHANGE_STATES[number];
  grant: EvidenceGrant;
  receipts: ParsedBridgeReceipt[];
}

export class StudioContractViolation extends Error {
  constructor(readonly reason: string, readonly path: string | null = null) {
    super(`Studio receipt contract violation: ${reason}`);
    this.name = "StudioContractViolation";
  }
}

/** The source a kind must arrive from: the guard is the service's, every other kind the bridge's. */
export function sourceOfKind(kind: BridgeReceiptKind): EvidenceSource {
  return kind === "guard" ? "service" : "bridge";
}

/**
 * Parse one envelope receipt strictly: the body's own kind must equal the
 * row's, the source must match the kind, the guard sits at service seq 0, and
 * a body seq (optional) must equal the row's.
 */
export function parseBridgeReceipt(kind: BridgeReceiptKind, seq: number, receipt: unknown, source: EvidenceSource = sourceOfKind(kind)): BridgeReceiptBody {
  if (source !== sourceOfKind(kind)) throw new StudioContractViolation("evidence_source_kind_mismatch");
  if (kind === "guard" && seq !== 0) throw new StudioContractViolation("guard_receipt_seq_not_zero");
  const parsed = BRIDGE_RECEIPT_SCHEMAS[kind].safeParse(receipt);
  if (!parsed.success) throw new StudioContractViolation(`bridge_${kind}_schema_invalid`, parsed.error.issues[0]?.path.join(".") ?? null);
  const body = parsed.data as BridgeReceiptBody & { seq?: number };
  if (body.seq !== undefined && body.seq !== seq) throw new StudioContractViolation("bridge_envelope_seq_mismatch");
  return parsed.data;
}

/**
 * Strictly parse the whole evidence answer. Any unknown key, free-text value,
 * kind/source/seq disagreement, receipt bound to a grant other than the
 * envelope's, or a duplicate (source, seq) rejects the entire answer: a
 * partially parsed evidence page is never evidence.
 */
export function parseQualificationEvidence(raw: unknown): ParsedQualificationEvidence {
  const envelope = QualificationEvidenceEnvelopeSchema.safeParse(raw);
  if (!envelope.success) throw new StudioContractViolation("evidence_envelope_schema_invalid", envelope.error.issues[0]?.path.join(".") ?? null);
  const seen = new Set<string>();
  const grantId = envelope.data.grant.grantId.toLowerCase();
  const receipts = envelope.data.receipts.map((entry) => {
    const key = `${entry.source}:${entry.seq}`;
    if (seen.has(key)) throw new StudioContractViolation("evidence_duplicate_source_seq");
    seen.add(key);
    const receipt = parseBridgeReceipt(entry.kind, entry.seq, entry.receipt, entry.source);
    if (receipt.grantId.toLowerCase() !== grantId || receipt.runBindingSha256 !== envelope.data.grant.runBindingSha256) {
      throw new StudioContractViolation("evidence_receipt_grant_mismatch");
    }
    return { source: entry.source, seq: entry.seq, kind: entry.kind, receivedAt: entry.receivedAt, receipt };
  });
  return { exchangeId: envelope.data.exchangeId.toLowerCase(), state: envelope.data.state, grant: envelope.data.grant, receipts };
}

export function parsePageReceipt(raw: unknown): StudioPageReceipt {
  const parsed = StudioPageReceiptSchema.safeParse(raw);
  if (!parsed.success) throw new StudioContractViolation("page_receipt_schema_invalid", parsed.error.issues[0]?.path.join(".") ?? null);
  return parsed.data;
}

/** Deterministic canonical JSON (code-unit key order) for content addressing. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Receipt coverage: every mandatory Lab evidence channel, mapped to the
// product receipt that serves it or to a typed status. Data, not prose.
// ---------------------------------------------------------------------------

export const COVERAGE_STATUSES = ["product_receipt", "lab_owned", "corroboration_only", "uncertain", "unsupported", "not_supported_by_product_privacy_model", "unavailable"] as const;
export type CoverageStatus = typeof COVERAGE_STATUSES[number];

export interface CoverageEntry {
  channel: string;
  status: CoverageStatus;
  /** Product receipt kinds (bridge kinds or `page:<event>`), or Lab event kinds for lab_owned. */
  sources: readonly string[];
  /** Fixed reason code, never prose. */
  reason: string | null;
}

export const STUDIO_G7_RECEIPT_COVERAGE: readonly CoverageEntry[] = Object.freeze([
  { channel: "input_source_manifest_and_audio_hash", status: "lab_owned", sources: ["utterance.resolved"], reason: null },
  { channel: "page_scheduling_start_completion_interruption", status: "lab_owned", sources: ["audio.input.scheduled", "audio.input.started", "audio.input.completed", "audio.input.interrupted", "audio.input.rejected"], reason: null },
  { channel: "actual_acquired_microphone_track", status: "product_receipt", sources: ["page:mic_published", "page:mic_unpublished", "harness.media_stream_issued"], reason: null },
  { channel: "downstream_pcm_frames_browser_to_provider", status: "unsupported", sources: [], reason: "no_browser_provider_socket_exists" },
  { channel: "downstream_pcm_window_envelope", status: "product_receipt", sources: ["input_window"], reason: "pcm_reconciliation_envelope_only" },
  { channel: "lab_vs_product_pcm_chain_equality", status: "unsupported", sources: [], reason: "lossy_opus_and_resampling" },
  { channel: "provider_input_transcription_and_turn_acceptance", status: "product_receipt", sources: ["input_turn"], reason: "observation_and_count_only" },
  { channel: "provider_input_transcript_content", status: "not_supported_by_product_privacy_model", sources: [], reason: "no_speech_text_retained" },
  { channel: "provider_output_transcription_fragments", status: "not_supported_by_product_privacy_model", sources: [], reason: "no_speech_text_retained" },
  { channel: "provider_lifecycle_and_usage", status: "product_receipt", sources: ["provider"], reason: null },
  { channel: "unique_provider_output_chunks", status: "product_receipt", sources: ["output_reply"], reason: "played_frame_chain_per_reply_not_per_chunk" },
  { channel: "playback_realization", status: "product_receipt", sources: ["output_reply", "page:sophia_playback"], reason: null },
  { channel: "output_leg_audio_artifact", status: "not_supported_by_product_privacy_model", sources: [], reason: "no_audio_retained" },
  { channel: "tool_calls_and_counts", status: "product_receipt", sources: ["input_turn", "session_closed"], reason: "counts_only" },
  // Task -> artifact version -> downloaded bytes is canonical (member API, as
  // the principal). Exchange/run -> task is not: NativeTask carries no
  // exchange or command-key binding, so that edge is joined by actor and
  // time window and typed `uncertain`, never pass.
  { channel: "builder_task_and_artifact_join", status: "uncertain", sources: ["GET /api/v1/projects/{p}/snapshot work", "GET /api/v1/projects/{p}/native-tasks/{t}", "GET /api/v1/artifacts/{a}/versions", "GET /api/v1/sources/{s}/content", "downloaded_bytes_sha256"], reason: "native_task_has_no_exchange_binding" },
  { channel: "canonical_transcript_with_content", status: "not_supported_by_product_privacy_model", sources: [], reason: "no_speech_text_retained" },
  { channel: "session_lifecycle", status: "product_receipt", sources: ["session_closed", "guard"], reason: null },
  { channel: "exchange_end_and_cleanup", status: "lab_owned", sources: ["studio.exchange.ownership", "studio.cleanup.exchange_ended", "studio.cleanup.signed_out", "cleanup.browser_context_closed"], reason: "ended_only_when_ownership_proven_else_observed_not_live" },
  { channel: "webrtc_packet_flow_on_loopback_peer", status: "unsupported", sources: [], reason: "fake_studio_loopback_peer_has_no_livekit_sfu" },
  { channel: "deployed_identity_api", status: "product_receipt", sources: ["GET /health commit"], reason: null },
  { channel: "deployed_identity_studio", status: "product_receipt", sources: ["meta[name=sophia-build]"], reason: null },
  { channel: "deployed_identity_bridge", status: "product_receipt", sources: ["provider.bridgeCommit"], reason: null },
  { channel: "webrtc_sender_stats", status: "corroboration_only", sources: ["studio.webrtc.sender_stats"], reason: "never_satisfies_a_receipt" },
  { channel: "captions_and_screenshots", status: "not_supported_by_product_privacy_model", sources: [], reason: "may_contain_speech_text" },
] satisfies CoverageEntry[]);

/**
 * Where the plan document (docs/plans/voice-qualification-g7.md) and
 * migration 0046 differ, the adapter follows the migration. Data, not prose:
 * each entry names the field and both readings.
 */
export const STUDIO_G7_CONTRACT_DIFFERENCES: ReadonlyArray<{ field: string; plan: string; migration_0046: string; adapter: string }> = Object.freeze([
  { field: "evidence.grant", plan: "grants (array covering the exchange)", migration_0046: "grant (single object)", adapter: "migration" },
  { field: "evidence.state", plan: "absent", migration_0046: "exchange state open|paused|ended", adapter: "migration" },
  { field: "evidence.receipts[].source", plan: "absent", migration_0046: "bridge|service", adapter: "migration" },
  { field: "evidence.receipts order", plan: "seq order", migration_0046: "source, then seq", adapter: "migration" },
  { field: "receipt.seq range", plan: "per-exchange sequence (start unspecified)", migration_0046: "0..99999 per (exchange, grant, source)", adapter: "migration; first bridge seq inferred as 0 when present, else 1" },
  { field: "receipt.kind", plan: "row kind only", migration_0046: "body kind required and equal to row kind", adapter: "migration" },
  { field: "receipt.schema", plan: "absent", migration_0046: "tests use sophia.bridge.<kind>.v1; guard sophia.service.guard.v1", adapter: "optional for bridge kinds, required for guard" },
  { field: "receipt.seq (body)", plan: "listed among fields", migration_0046: "row key; tests omit it from the body", adapter: "optional; equal to row seq when present" },
  { field: "guard.reason", plan: "deadline, expired, revoked, connections, usage", migration_0046: "adds turns", adapter: "migration (six)" },
  { field: "guard receipt", plan: "bridge-style receipt with seq", migration_0046: "service row, seq 0, no body seq", adapter: "migration" },
  { field: "grant.max_usage_tokens", plan: "1,000..2,000,000", migration_0046: "1,000..5,000,000", adapter: "migration" },
  { field: "grant limits", plan: "exchange seconds, connections, usage tokens", migration_0046: "adds max_turns 1..200 and max_output_tokens_per_turn 64..8192", adapter: "migration" },
  { field: "grant counters", plan: "absent", migration_0046: "connectionsOpened, turns, usageTokens, lastPromptTokens, expiresAt, revokedAt", adapter: "migration" },
  { field: "provider receipt counters", plan: "usageTokens only", migration_0046: "connectionsOpened, turns, usageTokens, lastPromptTokens", adapter: "optional counters accepted" },
  { field: "usage guard", plan: "tokens reported reach max_usage_tokens", migration_0046: "usage + last prompt + one turn's output cap reach the budget", adapter: "reported only; the Lab does not recompute it" },
  {
    field: "not found answer",
    plan: "404",
    migration_0046: "SQLSTATE 22023 'Qualification evidence not found'; the API (A15) answers 422 {code: 'not_found'} when the caller is not the grant's principal or no grant covers the exchange, as for every member read; 404 only when the route is absent (SOPHIA_VOICE_QUALIFICATION off)",
    adapter: "422 not_found: not_answered_to_principal (evidence) or not_found_for_principal (other member reads), unavailable; 404: endpoint_not_served, unavailable, never 'not yours' and never proof; any other 422/4xx/5xx: endpoint_unavailable; 401/403: auth_rejected",
  },
]);

/** Legacy Gemini-browser evidence kinds that this target never produces. */
export const LEGACY_ONLY_EVIDENCE: Readonly<Record<string, Exclude<CoverageStatus, "product_receipt" | "lab_owned" | "corroboration_only" | "uncertain" | "unavailable">>> = Object.freeze({
  "harness.input_frame_forwarded": "unsupported",
  "harness.provider_frame_sent": "unsupported",
  "harness.provider_frame_received": "unsupported",
  "audio.input.product_leg": "unsupported",
  "audio.input.product_turn": "unsupported",
  "session.finalized.canonical_transcript": "not_supported_by_product_privacy_model",
  "audio.output.leg_receipt": "not_supported_by_product_privacy_model",
});
