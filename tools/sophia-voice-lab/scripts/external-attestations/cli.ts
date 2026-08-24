#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { canonicalRequestHash } from "../../src/security.js";
import { ExternalAttestationSchema } from "../../src/service.js";
import {
  A03ControllerInputSchema,
  A03ExecutionRecordSchema,
  BearerSecretFileSchema,
  D02LocalControllerReceiptSchema,
  D02RenderWorkerTerminationInputSchema,
  D02WorkerTerminationControllerReceiptSchema,
  P01CollectorInputSchema,
  PublicAuthorityConfigSchema,
  TransportTokensSchema,
  parseSignedClaim,
  type PublicAuthorityConfig,
} from "./contracts.js";
import { buildA03ClaimFromManifest } from "./a03.js";
import { collectAndSignP01Claim } from "./p01.js";
import { initializeAuthorityFiles, verifyD02LocalReceipt, verifyD02WorkerTerminationReceipt } from "./crypto.js";
import { VerifiedAttestationReceiptSchema, executeA03LostResponse, postAttestationAndVerifyReplay } from "./http.js";
import { verifyManifestRevision } from "./manifest.js";
import { executeD02RenderRestart } from "./render-controller.js";
import { D02WorkerTerminationCheckpointSchema, executeD02RenderWorkerTermination, type D02WorkerTerminationCheckpoint } from "./render-worker-controller.js";
import { redactControllerValue, safeError } from "./redaction.js";
import { assertUnusedAbsolutePaths, readPublicFile, readPublicJson, readSecureFile, readSecureJson, writeNewSecureJson } from "./secure-files.js";

type Flags = ReadonlyMap<string, string>;

export interface CliRuntimeOverrides {
  workerTermination?: {
    fetchImpl?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => Date;
    allowHttpForTest?: boolean;
    afterCheckpoint?: (checkpoint: D02WorkerTerminationCheckpoint) => Promise<void>;
  };
}

export async function runCli(argv: readonly string[], write: (line: string) => void = (line) => process.stdout.write(`${line}\n`), runtime: CliRuntimeOverrides = {}): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (!command || command === "help" || command === "--help") {
      write(JSON.stringify({ ok: true, usage: usage() }));
      return 0;
    }
    const flags = parseFlags(rest);
    if (command === "hash-json") {
      assertOnly(flags, ["input"]);
      const value = await readSecureJson(requiredFlag(flags, "input"));
      writeSafe(write, { ok: true, command, canonical_sha256: hashCanonical(value), input_printed: false });
      return 0;
    }
    if (command === "init") {
      assertOnly(flags, ["public-config", "transport-tokens", "external-key", "deployment-key", "platform-key", "external-key-id", "deployment-key-id", "platform-key-id"]);
      const initialized = await initializeAuthorityFiles({
        publicConfigPath: requiredFlag(flags, "public-config"),
        transportTokensPath: requiredFlag(flags, "transport-tokens"),
        privateKeyPaths: {
          external_mcp_client: requiredFlag(flags, "external-key"),
          deployment_control: requiredFlag(flags, "deployment-key"),
          platform_plugin: requiredFlag(flags, "platform-key"),
        },
        keyIds: {
          external_mcp_client: requiredFlag(flags, "external-key-id"),
          deployment_control: requiredFlag(flags, "deployment-key-id"),
          platform_plugin: requiredFlag(flags, "platform-key-id"),
        },
      });
      writeSafe(write, { ok: true, command, public_config_sha256: initialized.publicConfigSha256, public_key_fingerprints: initialized.publicKeyFingerprints, private_key_material_printed: false, transport_tokens_printed: false });
      return 0;
    }

    if (command === "post") {
      assertOnly(flags, ["public-config", "transport-tokens", "base-url", "claim", "receipt-out"]);
      const publicConfig = await loadPublicConfig(requiredFlag(flags, "public-config"));
      const claim = parseSignedClaim(await readSecureJson(requiredFlag(flags, "claim")), publicConfig);
      const tokens = TransportTokensSchema.parse(await readSecureJson(requiredFlag(flags, "transport-tokens")));
      const receipt = await postAttestationAndVerifyReplay({ baseUrl: requiredFlag(flags, "base-url"), claim, publicConfig, transportTokens: tokens });
      await writeNewSecureJson(requiredFlag(flags, "receipt-out"), receipt);
      writeSafe(write, { ok: true, command, ...receipt, transport_token_printed: false });
      return 0;
    }

    if (command === "a03-execute") {
      assertOnly(flags, ["input", "mcp-token", "out"]);
      const controller = A03ControllerInputSchema.parse(await readSecureJson(requiredFlag(flags, "input")));
      const mcp = BearerSecretFileSchema.parse(await readSecureJson(requiredFlag(flags, "mcp-token")));
      const record = await executeA03LostResponse({ controller, mcpBearer: mcp.bearer_token });
      await writeNewSecureJson(requiredFlag(flags, "out"), record);
      writeSafe(write, { ok: true, command, run_id: record.run_id, operation_id: record.operation_id, retry_response_sha256: record.retry_response_sha256, initial_application_response_observed: false, retained_response_bytes: 0, bearer_printed: false });
      return 0;
    }

    if (command === "a03-build-claim") {
      assertOnly(flags, ["record", "manifest", "public-config", "private-key", "out"]);
      const publicConfig = await loadPublicConfig(requiredFlag(flags, "public-config"));
      const record = A03ExecutionRecordSchema.parse(await readSecureJson(requiredFlag(flags, "record")));
      const manifest = await readPublicJson(requiredFlag(flags, "manifest"));
      const claim = await buildA03ClaimFromManifest({ record, manifest, publicConfig, externalClientPrivateKeyPath: requiredFlag(flags, "private-key") });
      await writeNewSecureJson(requiredFlag(flags, "out"), claim);
      writeSafe(write, { ok: true, command, run_id: claim.run_id, operation_id: record.operation_id, signed_claim_sha256: hashCanonical(claim), signature_printed: false });
      return 0;
    }

    if (command === "p01-collect-claim") {
      assertOnly(flags, ["input", "public-config", "private-key", "capture-out", "out"]);
      const captureOut = requiredFlag(flags, "capture-out");
      const claimOut = requiredFlag(flags, "out");
      await assertUnusedAbsolutePaths([captureOut, claimOut]);
      const controllerInput = P01CollectorInputSchema.parse(await readSecureJson(requiredFlag(flags, "input")));
      const publicConfig = await loadPublicConfig(requiredFlag(flags, "public-config"));
      const result = await collectAndSignP01Claim({
        controllerInput,
        publicConfig,
        platformPrivateKeyPath: requiredFlag(flags, "private-key"),
        persistCapture: async (capture) => writeNewSecureJson(captureOut, capture),
      });
      await writeNewSecureJson(claimOut, result.claim);
      writeSafe(write, {
        ok: true,
        command,
        run_id: result.claim.run_id,
        registered_app_id: result.claim.evidence.kind === "p01_platform_plugin_task" ? result.claim.evidence.registered_app_id : null,
        source_receipt_sha256: result.capture.derived.source_receipt_sha256,
        capture_sha256: hashCanonical(result.capture),
        signed_claim_sha256: hashCanonical(result.claim),
        call_count: result.capture.derived.call_count,
        raw_frames_printed: false,
        signature_printed: false,
      });
      return 0;
    }

    if (command === "d02-render-restart") {
      assertOnly(flags, ["input", "public-config", "transport-tokens", "deployment-key", "render-token", "mcp-token", "bundle-dir"]);
      const bundleDir = requiredFlag(flags, "bundle-dir");
      if (!path.isAbsolute(bundleDir) || path.normalize(bundleDir) !== bundleDir) throw new Error("Bundle directory must be absolute and normalized.");
      const outputs = ["00-one-shot-intent.json", "01-command-claim.json", "02-command-receipt.json", "03-render-accepted.json", "04-render-controller-receipt.json", "05-final-claim.json", "06-final-receipt.json", "07-summary.json"].map((name) => path.join(bundleDir, name));
      await assertUnusedAbsolutePaths(outputs);
      const controllerRaw = await readSecureJson(requiredFlag(flags, "input"));
      const controller = (await import("./contracts.js")).D02RenderControllerInputSchema.parse(controllerRaw);
      const publicConfig = await loadPublicConfig(requiredFlag(flags, "public-config"));
      const tokens = TransportTokensSchema.parse(await readSecureJson(requiredFlag(flags, "transport-tokens")));
      const render = BearerSecretFileSchema.parse(await readSecureJson(requiredFlag(flags, "render-token")));
      const mcp = BearerSecretFileSchema.parse(await readSecureJson(requiredFlag(flags, "mcp-token")));
      await writeNewSecureJson(outputs[0]!, { schema: "sophia_voice_lab_d02_one_shot_intent_v1", armed: true, controller_input_sha256: hashCanonical(controller), service_id_sha256: controller.authorization.service_id_sha256, run_id: controller.run.run_id, operation_id: controller.operation.operation_id, restart_submitted: false, rerun_forbidden: true });
      const result = await executeD02RenderRestart({
        controller, renderBearer: render.bearer_token, mcpBearer: mcp.bearer_token, publicConfig, transportTokens: tokens, deploymentPrivateKeyPath: requiredFlag(flags, "deployment-key"),
        checkpoint: async (checkpoint) => {
          if (checkpoint.phase === "command_attached") {
            await writeNewSecureJson(outputs[1]!, checkpoint.claim);
            await writeNewSecureJson(outputs[2]!, checkpoint.receipt);
          } else if (checkpoint.phase === "render_restart_accepted") await writeNewSecureJson(outputs[3]!, checkpoint.receipt);
          else if (checkpoint.phase === "render_settled") await writeNewSecureJson(outputs[4]!, checkpoint.receipt);
          else {
            await writeNewSecureJson(outputs[5]!, checkpoint.claim);
            await writeNewSecureJson(outputs[6]!, checkpoint.receipt);
          }
        },
      });
      await writeNewSecureJson(outputs[7]!, { schema: "sophia_voice_lab_d02_controller_summary_v1", ...result.provider_action, local_controller_receipt_sha256: result.local_controller_receipt_sha256, command_event_seq: result.command_receipt.event_seq, final_event_seq: result.final_receipt.event_seq, exact_replay_verified: result.final_receipt.exact_replay_verified });
      writeSafe(write, { ok: true, command, run_id: controller.run.run_id, provider_action: result.provider_action, local_controller_receipt_sha256: result.local_controller_receipt_sha256, command_event_seq: result.command_receipt.event_seq, final_event_seq: result.final_receipt.event_seq, render_token_printed: false, mcp_token_printed: false });
      return 0;
    }

    if (command === "d02-render-worker-loss") {
      assertOnly(flags, ["input", "public-config", "transport-tokens", "deployment-key", "render-token", "bundle-dir", "resume"]);
      const bundleDir = requiredFlag(flags, "bundle-dir");
      if (!path.isAbsolute(bundleDir) || path.normalize(bundleDir) !== bundleDir) throw new Error("Bundle directory must be absolute and normalized.");
      const resumeRequested = flags.has("resume");
      if (resumeRequested && flags.get("resume") !== "true") throw new Error("--resume accepts only the literal value true.");
      const outputs = D02_WORKER_JOURNAL_FILES.map((name) => path.join(bundleDir, name));
      const controller = D02RenderWorkerTerminationInputSchema.parse(await readSecureJson(requiredFlag(flags, "input")));
      const controllerInputSha256 = hashCanonical(controller);
      const publicConfig = await loadPublicConfig(requiredFlag(flags, "public-config"));
      const tokens = TransportTokensSchema.parse(await readSecureJson(requiredFlag(flags, "transport-tokens")));
      const render = BearerSecretFileSchema.parse(await readSecureJson(requiredFlag(flags, "render-token")));
      const deploymentKeyPath = requiredFlag(flags, "deployment-key");
      const journalMacKey = await readSecureFile(deploymentKeyPath);
      try {
        const lock = await acquireD02WorkerBundleLock(bundleDir, controllerInputSha256);
        try {
          let entries: D02WorkerJournalEntry[];
          if (resumeRequested) {
            entries = await loadD02WorkerJournal(outputs, controllerInputSha256, journalMacKey);
            if (entries.length === 0) throw new Error("D02 --resume requires an existing immutable worker journal intent.");
          } else {
            await assertUnusedAbsolutePaths(outputs);
            const intent = {
              schema: "sophia_voice_lab_d02_worker_one_shot_intent_v2",
              armed: true,
              worker_service_id_sha256: controller.authorization.service_id_sha256,
              run_id: controller.run.run_id,
              cleanup_obligation_id_sha256: controller.run.cleanup_obligation_id_sha256,
              restart_submitted: false,
              resume_required_after_interruption: true,
            };
            entries = [await appendD02WorkerJournalEntry(outputs[0]!, 0, "intent", controllerInputSha256, null, intent, journalMacKey)];
          }

          const journalAlreadyComplete = entries.length === D02_WORKER_JOURNAL_FILES.length;
          const resumeCheckpoints = entries.slice(1, Math.min(entries.length, D02_WORKER_JOURNAL_FILES.length - 1)).map((entry) => entry.payload);
          let nextIndex = entries.length;
          let previousEntrySha256 = entries.at(-1)!.entry_sha256;
          const workerRuntime = runtime.workerTermination;
          const result = await executeD02RenderWorkerTermination({
            controller,
            renderBearer: render.bearer_token,
            publicConfig,
            transportTokens: tokens,
            deploymentPrivateKeyPath: deploymentKeyPath,
            ...(workerRuntime?.fetchImpl === undefined ? {} : { fetchImpl: workerRuntime.fetchImpl }),
            ...(workerRuntime?.sleep === undefined ? {} : { sleep: workerRuntime.sleep }),
            ...(workerRuntime?.now === undefined ? {} : { now: workerRuntime.now }),
            ...(workerRuntime?.allowHttpForTest === undefined ? {} : { allowHttpForTest: workerRuntime.allowHttpForTest }),
            resumeCheckpoints,
            checkpoint: async (rawCheckpoint) => {
              const checkpoint = D02WorkerTerminationCheckpointSchema.parse(rawCheckpoint);
              assertD02WorkerJournalCheckpointPosition(nextIndex, checkpoint);
              const entry = await appendD02WorkerJournalEntry(outputs[nextIndex]!, nextIndex, checkpoint.phase, controllerInputSha256, previousEntrySha256, checkpoint, journalMacKey);
              entries.push(entry);
              previousEntrySha256 = entry.entry_sha256;
              nextIndex += 1;
              await workerRuntime?.afterCheckpoint?.(checkpoint);
            },
          });
          const summary = D02WorkerSummarySchema.parse({
            schema: "sophia_voice_lab_d02_worker_controller_summary_v2",
            provider_action: result.provider_action,
            local_controller_receipt_sha256: result.local_controller_receipt_sha256,
            command_event_seq: result.command_receipt.event_seq,
            final_event_seq: result.final_receipt.event_seq,
            exact_replay_verified: result.final_receipt.exact_replay_verified,
            gateway_settlement_status: "product_authenticated_settlement_committed",
            certification_status: "pending_evaluator_cross_join",
          });
          if (journalAlreadyComplete) {
            const persistedSummary = D02WorkerSummarySchema.parse(entries.at(-1)!.payload);
            if (hashCanonical(persistedSummary) !== hashCanonical(summary)) throw new Error("D02 completed journal summary does not match its verified immutable phase prefix.");
            writeSafe(write, { ok: true, command, resumed: true, run_id: controller.run.run_id, ...summary, render_token_printed: false });
            return 0;
          }
          const summaryEntry = await appendD02WorkerJournalEntry(outputs[nextIndex]!, nextIndex, "summary", controllerInputSha256, previousEntrySha256, summary, journalMacKey);
          entries.push(summaryEntry);
          writeSafe(write, { ok: true, command, resumed: resumeRequested, run_id: controller.run.run_id, ...summary, render_token_printed: false });
          return 0;
        } finally {
          await lock.release();
        }
      } finally {
        journalMacKey.fill(0);
      }
    }

    if (command === "verify-manifest") {
      assertOnly(flags, ["claim", "receipt", "manifest", "prior-manifest", "manifest-sha256"]);
      const claim = ExternalAttestationSchema.parse(await readSecureJson(requiredFlag(flags, "claim")));
      const receipt = VerifiedAttestationReceiptSchema.parse(await readSecureJson(requiredFlag(flags, "receipt")));
      const manifestBytes = await readPublicFile(requiredFlag(flags, "manifest"));
      const priorPath = flags.get("prior-manifest");
      const result = verifyManifestRevision({ manifestBytes, claim, receipt, ...(priorPath ? { priorManifestBytes: await readPublicFile(priorPath) } : {}), ...(flags.get("manifest-sha256") ? { expectedManifestSha256: flags.get("manifest-sha256")! } : {}) });
      writeSafe(write, { ok: true, command, ...result });
      return 0;
    }

    if (command === "verify-d02-local-receipt") {
      assertOnly(flags, ["public-config", "receipt"]);
      const publicConfig = await loadPublicConfig(requiredFlag(flags, "public-config"));
      const receipt = D02LocalControllerReceiptSchema.parse(await readSecureJson(requiredFlag(flags, "receipt")));
      verifyD02LocalReceipt(receipt, publicConfig);
      writeSafe(write, { ok: true, command, run_id: receipt.run_id, restart_request_id: receipt.restart_request_id, receipt_sha256: hashCanonical(receipt), signature_valid: true, signature_printed: false });
      return 0;
    }

    if (command === "verify-d02-worker-receipt") {
      assertOnly(flags, ["public-config", "receipt"]);
      const publicConfig = await loadPublicConfig(requiredFlag(flags, "public-config"));
      const raw = unwrapD02WorkerJournalPayload(await readSecureJson(requiredFlag(flags, "receipt")));
      const checkpoint = D02WorkerTerminationCheckpointSchema.safeParse(raw);
      const receipt = D02WorkerTerminationControllerReceiptSchema.parse(checkpoint.success && checkpoint.data.phase === "render_worker_replacement_settled" ? checkpoint.data.receipt : raw);
      verifyD02WorkerTerminationReceipt(receipt, publicConfig);
      writeSafe(write, { ok: true, command, run_id: receipt.run_id, termination_request_id: receipt.termination_request_id, receipt_sha256: hashCanonical(receipt), signature_valid: true, gateway_settlement_status: receipt.gateway.settlement_schema_status, signature_printed: false });
      return 0;
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    write(JSON.stringify({ ok: false, ...safeError(error) }));
    return 1;
  }
}

const D02_WORKER_JOURNAL_FILES = [
  "00-one-shot-worker-intent.json",
  "01-render-worker-preflight.json",
  "02-worker-command-claim.json",
  "03-worker-command-response.json",
  "04-worker-command-replay-response.json",
  "05-worker-command-receipt.json",
  "06-render-worker-dispatch-intent.json",
  "07-render-worker-accepted.json",
  "08-render-worker-controller-receipt.json",
  "09-worker-loss-claim.json",
  "10-worker-loss-response.json",
  "11-worker-loss-replay-response.json",
  "12-worker-loss-receipt.json",
  "13-worker-loss-summary.json",
] as const;

const D02_WORKER_PHASES = [
  "intent",
  "preflight_prepared",
  "command_prepared",
  "command_attestation_response",
  "command_attestation_response",
  "command_attached",
  "render_worker_dispatch_intent",
  "render_worker_restart_accepted",
  "render_worker_replacement_settled",
  "final_prepared",
  "final_attestation_response",
  "final_attestation_response",
  "final_attached",
  "summary",
] as const;

const D02WorkerJournalEntrySchema = z.object({
  schema: z.literal("sophia_voice_lab_d02_worker_phase_journal_v1"),
  index: z.number().int().min(0).max(D02_WORKER_JOURNAL_FILES.length - 1),
  phase: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/),
  controller_input_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  previous_entry_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  payload: z.unknown(),
  entry_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  entry_hmac_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

type D02WorkerJournalEntry = z.infer<typeof D02WorkerJournalEntrySchema>;

const D02WorkerSummarySchema = z.object({
  schema: z.literal("sophia_voice_lab_d02_worker_controller_summary_v2"),
  provider_action: z.object({
    worker_service_id_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    action_request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    action_accepted_response_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    action_settled_snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    before_instance_set_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    after_instance_set_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.literal("settled_live_replacement"),
  }).strict(),
  local_controller_receipt_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  command_event_seq: z.number().int().positive(),
  final_event_seq: z.number().int().positive(),
  exact_replay_verified: z.literal(true),
  gateway_settlement_status: z.literal("product_authenticated_settlement_committed"),
  certification_status: z.literal("pending_evaluator_cross_join"),
}).strict();

const D02WorkerLockSchema = z.object({
  schema: z.literal("sophia_voice_lab_d02_worker_bundle_lock_v1"),
  pid: z.number().int().positive(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  controller_input_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  acquired_at: z.string().datetime({ offset: true }),
}).strict();

async function appendD02WorkerJournalEntry(
  target: string,
  index: number,
  phase: string,
  controllerInputSha256: string,
  previousEntrySha256: string | null,
  payload: unknown,
  journalMacKey: Buffer,
): Promise<D02WorkerJournalEntry> {
  assertD02WorkerJournalPosition(index, phase, payload);
  const core = {
    schema: "sophia_voice_lab_d02_worker_phase_journal_v1" as const,
    index,
    phase,
    controller_input_sha256: controllerInputSha256,
    previous_entry_sha256: previousEntrySha256,
    payload,
  };
  const entry = D02WorkerJournalEntrySchema.parse({
    ...core,
    entry_sha256: hashCanonical(core),
    entry_hmac_sha256: d02WorkerJournalHmac(core, journalMacKey),
  });
  await writeNewSecureJson(target, entry);
  return entry;
}

async function loadD02WorkerJournal(paths: readonly string[], controllerInputSha256: string, journalMacKey: Buffer): Promise<D02WorkerJournalEntry[]> {
  const present = await Promise.all(paths.map(async (target) => {
    try { await lstat(target); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }));
  const firstGap = present.indexOf(false);
  if (firstGap >= 0 && present.slice(firstGap + 1).some(Boolean)) throw new Error("D02 resume journal is gapped; later immutable phases exist after a missing phase.");
  const count = firstGap < 0 ? paths.length : firstGap;
  const entries: D02WorkerJournalEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry = D02WorkerJournalEntrySchema.parse(await readSecureJson(paths[index]!));
    const core = {
      schema: entry.schema,
      index: entry.index,
      phase: entry.phase,
      controller_input_sha256: entry.controller_input_sha256,
      previous_entry_sha256: entry.previous_entry_sha256,
      payload: entry.payload,
    };
    if (entry.index !== index || entry.phase !== D02_WORKER_PHASES[index] || entry.controller_input_sha256 !== controllerInputSha256
      || entry.previous_entry_sha256 !== (index === 0 ? null : entries[index - 1]!.entry_sha256)
      || entry.entry_sha256 !== hashCanonical(core)
      || !constantTimeHexEqual(entry.entry_hmac_sha256, d02WorkerJournalHmac(core, journalMacKey))) throw new Error(`D02 resume journal phase ${index} is tampered, reordered, or bound to a different controller input or deployment key.`);
    assertD02WorkerJournalPosition(index, entry.phase, entry.payload);
    entries.push(entry);
  }
  return entries;
}

function d02WorkerJournalHmac(core: unknown, key: Buffer): string {
  return createHmac("sha256", key).update("sophia-voice-lab:d02-worker-journal:v1\0", "utf8").update(hashCanonical(core), "ascii").digest("hex");
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function assertD02WorkerJournalCheckpointPosition(index: number, checkpoint: D02WorkerTerminationCheckpoint): void {
  assertD02WorkerJournalPosition(index, checkpoint.phase, checkpoint);
}

function assertD02WorkerJournalPosition(index: number, phase: string, payload: unknown): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= D02_WORKER_PHASES.length || D02_WORKER_PHASES[index] !== phase) throw new Error(`D02 journal attempted a gapped or reordered phase at position ${index}.`);
  if (index === 0) {
    const intent = z.object({
      schema: z.literal("sophia_voice_lab_d02_worker_one_shot_intent_v2"),
      armed: z.literal(true),
      worker_service_id_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      run_id: z.string().uuid(),
      cleanup_obligation_id_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      restart_submitted: z.literal(false),
      resume_required_after_interruption: z.literal(true),
    }).strict().parse(payload);
    if (!intent.armed) throw new Error("D02 worker journal intent is not armed.");
    return;
  }
  if (index === D02_WORKER_PHASES.length - 1) {
    D02WorkerSummarySchema.parse(payload);
    return;
  }
  const checkpoint = D02WorkerTerminationCheckpointSchema.parse(payload);
  if ((index === 3 || index === 10) && !("response" in checkpoint && checkpoint.response.ordinal === 1)) throw new Error("D02 journal first-response checkpoint has the wrong ordinal.");
  if ((index === 4 || index === 11) && !("response" in checkpoint && checkpoint.response.ordinal === 2)) throw new Error("D02 journal replay-response checkpoint has the wrong ordinal.");
}

async function acquireD02WorkerBundleLock(bundleDir: string, controllerInputSha256: string): Promise<{ release: () => Promise<void> }> {
  const directory = await lstat(bundleDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("D02 worker bundle directory must be a real directory, not a symlink.");
  const lockPath = path.join(bundleDir, ".d02-worker-controller.lock");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomBytes(32).toString("hex");
    let handle: FileHandle;
    try {
      const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
      handle = await open(lockPath, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = D02WorkerLockSchema.parse(await readSecureJson(lockPath));
      if (processIsAlive(existing.pid)) throw new Error("D02 worker bundle is already locked by another live controller invocation.");
      const stalePath = path.join(bundleDir, `.d02-worker-controller.lock.stale.${randomBytes(12).toString("hex")}`);
      try { await rename(lockPath, stalePath); await unlink(stalePath); }
      catch (staleError) {
        if ((staleError as NodeJS.ErrnoException).code !== "ENOENT") throw staleError;
      }
      continue;
    }
    const lockValue = D02WorkerLockSchema.parse({
      schema: "sophia_voice_lab_d02_worker_bundle_lock_v1",
      pid: process.pid,
      token,
      controller_input_sha256: controllerInputSha256,
      acquired_at: new Date().toISOString(),
    });
    try {
      await handle.writeFile(`${JSON.stringify(lockValue, null, 2)}\n`, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
    return {
      release: async () => {
        await handle.close();
        const current = D02WorkerLockSchema.parse(await readSecureJson(lockPath));
        if (current.token !== token || current.pid !== process.pid) throw new Error("D02 worker bundle lock ownership changed during the controller invocation.");
        await unlink(lockPath);
      },
    };
  }
  throw new Error("D02 worker bundle lock could not be acquired after stale-lock reconciliation.");
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function parseFlags(args: readonly string[]): Flags {
  if (args.length % 2 !== 0) throw new Error("Every CLI flag requires exactly one value.");
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1]!;
    if (!/^--[a-z0-9-]+$/.test(key) || value.startsWith("--")) throw new Error("CLI arguments must be exact --name value pairs.");
    const normalized = key.slice(2);
    if (result.has(normalized)) throw new Error(`Duplicate CLI flag: --${normalized}`);
    result.set(normalized, value);
  }
  return result;
}

function requiredFlag(flags: Flags, name: string): string {
  const value = flags.get(name);
  if (!value) throw new Error(`Missing required flag --${name}.`);
  return value;
}

function assertOnly(flags: Flags, allowed: readonly string[]): void {
  for (const key of flags.keys()) if (!allowed.includes(key)) throw new Error(`Unsupported flag for this command: --${key}.`);
}

async function loadPublicConfig(target: string): Promise<PublicAuthorityConfig> {
  return PublicAuthorityConfigSchema.parse(await readPublicJson(target));
}

function hashCanonical(value: unknown): string {
  // Importing through the source keeps this controller on the server's exact
  // sorted-key hashing contract without exposing the underlying value.
  return canonicalRequestHash(value);
}

function unwrapD02WorkerJournalPayload(value: unknown): unknown {
  const entry = D02WorkerJournalEntrySchema.safeParse(value);
  if (!entry.success) return value;
  const core = {
    schema: entry.data.schema,
    index: entry.data.index,
    phase: entry.data.phase,
    controller_input_sha256: entry.data.controller_input_sha256,
    previous_entry_sha256: entry.data.previous_entry_sha256,
    payload: entry.data.payload,
  };
  if (entry.data.entry_sha256 !== hashCanonical(core)) throw new Error("D02 worker journal entry hash is invalid.");
  return entry.data.payload;
}

function writeSafe(write: (line: string) => void, value: unknown): void {
  write(JSON.stringify(redactControllerValue(value)));
}

function usage(): Record<string, string> {
  return {
    "hash-json": "Hash a secure exact JSON value with the server's canonical sorted-key SHA-256 contract without printing the input.",
    init: "Generate three distinct Ed25519 PKCS8 files, exact public config, and exact transport-token JSON into new absolute mode-0600 paths.",
    post: "POST a signed claim with its source token, then exact-replay it to verify the immutable receipt.",
    "a03-execute": "Abandon one real public MCP speak response and replay the exact idempotency key; write only a content-free client record.",
    "a03-build-claim": "Join the A03 client record to a terminal manifest and sign only when both owning HTTP audits and the durable operation hash agree.",
    "p01-collect-claim": "Run signed Codex CLI plugin/app-server sources, persist their raw receipt bundle, and sign only the derived exact ten-call P01 claim.",
    "d02-render-restart": "Submit exactly one Render restart after a signed command, settle deploy/instance/boot, replay MCP, and attach the final proof.",
    "d02-render-worker-loss": "Persist a signed command, restart exactly one Render background-worker service once, and use --resume true with the same hash-chained bundle after interruption; ambiguous Render dispatch is GET-only/manual-required.",
    "verify-d02-local-receipt": "Verify the separate signed Render-controller request/accepted/settled receipt without printing its signature.",
    "verify-d02-worker-receipt": "Verify the source-specific signed Render browser-worker termination receipt; Gateway settlement remains a separate mandatory proof.",
    "verify-manifest": "Verify an immutable attestation receipt appears in a later append-only evidence-manifest revision.",
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
