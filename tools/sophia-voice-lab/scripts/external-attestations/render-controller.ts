import { randomBytes, randomUUID } from "node:crypto";

import { canonicalRequestHash, sha256 } from "../../src/security.js";
import {
  D02LocalControllerReceiptSchema,
  D02BrowserContinuityProofSchema,
  D02RenderControllerInputSchema,
  type D02BrowserContinuityProof,
  type D02LocalControllerReceipt,
  type D02RenderControllerInput,
  type PublicAuthorityConfig,
  type SignedExternalAttestation,
  type TransportTokens,
} from "./contracts.js";
import { newUnsignedClaim, signD02LocalReceipt, signExternalClaim } from "./crypto.js";
import { callMcpTool, postAttestationAndVerifyReplay, type VerifiedAttestationReceipt } from "./http.js";

const MAX_PROVIDER_RESPONSE_BYTES = 2_000_000;

interface VersionIdentity {
  service: "sophia-voice-lab-mcp";
  commit_sha: string;
  boot_id_sha256: string;
  instance_id_sha256: string;
  version_response_sha256: string;
}

interface RenderSnapshot {
  serviceResponseSha256: string;
  deployResponseSha256: string;
  instanceResponseSha256: string;
  serviceId: string;
  deployId: string;
  deployStatus: string;
  deployStartedAt: string;
  deploySettledAt: string | null;
  instanceIds: string[];
  instanceSetSha256: string;
  newInstanceCreatedAt: string | null;
}

export interface D02RenderControllerResult {
  command_claim: SignedExternalAttestation;
  command_receipt: VerifiedAttestationReceipt;
  local_controller_receipt: D02LocalControllerReceipt;
  local_controller_receipt_sha256: string;
  final_claim: SignedExternalAttestation;
  final_receipt: VerifiedAttestationReceipt;
  provider_action: {
    service_id_sha256: string;
    request_sha256: string;
    accepted_response_sha256: string;
    before_deploy_id_sha256: string;
    after_deploy_id_sha256: string;
    before_instance_set_sha256: string;
    after_instance_set_sha256: string;
    state: "settled_live";
  };
}

export type D02ControllerCheckpoint =
  | { phase: "command_attached"; claim: SignedExternalAttestation; receipt: VerifiedAttestationReceipt }
  | { phase: "render_restart_accepted"; receipt: { request_sha256: string; response_sha256: string; http_status: 200; requested_at: string; accepted_at: string } }
  | { phase: "render_settled"; receipt: D02LocalControllerReceipt; receipt_sha256: string }
  | { phase: "final_attached"; claim: SignedExternalAttestation; receipt: VerifiedAttestationReceipt };

/**
 * Execute the one destructive D02 action. The function has no retry loop for
 * POST /restart: it submits exactly once, then only polls read-only endpoints.
 * Every prerequisite is checked before that POST and every proof is checked
 * before either the local or server final attestation is signed.
 */
export async function executeD02RenderRestart(input: {
  controller: D02RenderControllerInput;
  renderBearer: string;
  mcpBearer: string;
  publicConfig: PublicAuthorityConfig;
  transportTokens: TransportTokens;
  deploymentPrivateKeyPath: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  allowHttpForTest?: boolean;
  checkpoint?: (checkpoint: D02ControllerCheckpoint) => Promise<void>;
}): Promise<D02RenderControllerResult> {
  const controller = D02RenderControllerInputSchema.parse(input.controller);
  if (Buffer.byteLength(input.renderBearer) < 32 || Buffer.byteLength(input.mcpBearer) < 32) throw new Error("Controller bearer credential is invalid.");
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = input.now ?? (() => new Date());

  const beforeVersion = await readVersion(controller.voice_lab_url, fetchImpl, input.allowHttpForTest === true);
  assertCandidateVersion(beforeVersion, controller.run.expected_deployment.backend);
  const before = await readRenderSnapshot(controller, input.renderBearer, fetchImpl, null);
  if (before.serviceId !== controller.render_service_id) throw new Error("Render API returned a different service than the explicitly authorized target.");
  if (before.deployStatus !== "live") throw new Error("Render service has no live before-deploy; refusing a restart during another deployment state.");
  if (before.instanceIds.length < 1) throw new Error("Render service has no exact live before-instance set.");

  const restartRequestId = randomUUID();
  const renderRequestPathHash = sha256(`/v1/services/${controller.render_service_id}/restart`);
  const renderRequestSha256 = canonicalRequestHash({ method: "POST", provider: "render", path_sha256: renderRequestPathHash, body_sha256: sha256(Buffer.alloc(0)), restart_request_id_sha256: sha256(restartRequestId) });
  const restartRequestedAt = now();
  const commandEvidence = {
    kind: "d02_restart_command" as const,
    authority: "deployment_control" as const,
    restart_request_id: restartRequestId,
    operation_id: controller.operation.operation_id,
    request_sha256: controller.operation.request_sha256,
    idempotency_key_sha256: controller.operation.idempotency_key_sha256,
    before_boot_id_sha256: beforeVersion.boot_id_sha256,
    before_instance_id_sha256: beforeVersion.instance_id_sha256,
    before_version_response_sha256: beforeVersion.version_response_sha256,
    browser_worker_id_sha256: controller.browser.worker_id_sha256,
    browser_lease_epoch: controller.browser.lease_epoch,
    provider_restart_request_sha256: renderRequestSha256,
    requested_at: restartRequestedAt.toISOString(),
    target_service: "sophia-voice-lab-mcp" as const,
    restart_mode: "one_shot_after_durable_acceptance" as const,
    response_loss_expected: true as const,
    provider_mutation_authorized: false as const,
    one_shot: true as const,
  };
  const commandClaim = await signExternalClaim(newUnsignedClaim({ run: controller.run, authority: "deployment_control", publicConfig: input.publicConfig, evidence: commandEvidence, now: restartRequestedAt }), input.publicConfig, input.deploymentPrivateKeyPath, restartRequestedAt);
  const commandReceipt = await postAttestationAndVerifyReplay({ baseUrl: controller.voice_lab_url, claim: commandClaim, publicConfig: input.publicConfig, transportTokens: input.transportTokens, fetchImpl, ...(input.allowHttpForTest === undefined ? {} : { allowHttpForTest: input.allowHttpForTest }) });
  await input.checkpoint?.({ phase: "command_attached", claim: commandClaim, receipt: commandReceipt });

  // The signed command is durable before the single provider mutation.
  const renderRequestedAt = now();
  const accepted = await renderRequest({
    url: new URL(`/v1/services/${encodeURIComponent(controller.render_service_id)}/restart`, controller.render_api_origin),
    method: "POST",
    bearer: input.renderBearer,
    fetchImpl,
  });
  const renderAcceptedAt = now();
  if (accepted.status !== 200) throw new Error(`Render restart was not accepted exactly once (HTTP ${accepted.status}).`);
  await input.checkpoint?.({ phase: "render_restart_accepted", receipt: { request_sha256: renderRequestSha256, response_sha256: accepted.responseSha256, http_status: 200, requested_at: renderRequestedAt.toISOString(), accepted_at: renderAcceptedAt.toISOString() } });

  const deadline = Date.now() + controller.poll.timeout_ms;
  let afterVersion: VersionIdentity | null = null;
  let after: RenderSnapshot | null = null;
  while (Date.now() < deadline) {
    const [candidateVersion, candidateSnapshot] = await Promise.all([
      readVersion(controller.voice_lab_url, fetchImpl, input.allowHttpForTest === true).catch(() => null),
      readRenderSnapshot(controller, input.renderBearer, fetchImpl, restartRequestedAt).catch(() => null),
    ]);
    if (candidateVersion && candidateSnapshot) {
      assertCandidateVersion(candidateVersion, controller.run.expected_deployment.backend);
      const beforeInstancesGone = before.instanceIds.every((id) => !candidateSnapshot.instanceIds.includes(id));
      const newDeploy = candidateSnapshot.deployId !== before.deployId && candidateSnapshot.deployStatus === "live";
      const newProcess = candidateVersion.boot_id_sha256 !== beforeVersion.boot_id_sha256 && candidateVersion.instance_id_sha256 !== beforeVersion.instance_id_sha256;
      if (beforeInstancesGone && newDeploy && newProcess && candidateSnapshot.newInstanceCreatedAt !== null && candidateSnapshot.deploySettledAt !== null) {
        afterVersion = candidateVersion;
        after = candidateSnapshot;
        break;
      }
    }
    await sleep(controller.poll.interval_ms);
  }
  if (!afterVersion || !after) throw new Error("Render restart did not settle to a distinct live deploy/instance/boot within the bounded controller deadline.");

  const replay = await callMcpTool({
    mcpUrl: controller.voice_lab_url,
    bearer: input.mcpBearer,
    toolName: controller.operation.operation_type,
    arguments: controller.operation.replay_arguments,
    fetchImpl,
    ...(input.allowHttpForTest === undefined ? {} : { allowHttpForTest: input.allowHttpForTest }),
    timeoutMs: 180_000,
  });
  const replayObservedAt = now();
  if (replay.envelope.run_id !== controller.run.run_id || replay.envelope.operation_id !== controller.operation.operation_id || replay.envelope.status !== "completed" || replay.envelope.data.operation_state !== "succeeded" || replay.envelope.data.replay !== true) throw new Error("Post-restart MCP replay did not return the exact original succeeded operation.");
  const instanceCreatedAt = new Date(after.newInstanceCreatedAt!);
  const deploySettledAt = after.deploySettledAt;
  if (deploySettledAt === null) throw new Error("Render live deploy lacks an exact settlement timestamp.");
  if (Number.isNaN(instanceCreatedAt.getTime()) || instanceCreatedAt < restartRequestedAt || instanceCreatedAt > replayObservedAt) throw new Error("Render new-instance timestamp cannot bind the service boot/replay interval.");

  // The controller never asserts browser continuity. It polls this read-only
  // proof until the Voice Lab server observes a durable heartbeat strictly
  // after both the new web boot and the immutable replay event.
  let browserContinuity: D02BrowserContinuityProof | null = null;
  while (Date.now() < deadline) {
    browserContinuity = await readBrowserContinuity({
      baseUrl: controller.voice_lab_url,
      bearer: input.transportTokens.deployment_control,
      runId: controller.run.run_id,
      restartRequestIdSha256: sha256(restartRequestId),
      operationId: controller.operation.operation_id,
      afterBootIdSha256: afterVersion.boot_id_sha256,
      fetchImpl,
      allowHttpForTest: input.allowHttpForTest === true,
    }).catch(() => null);
    if (browserContinuity) break;
    await sleep(controller.poll.interval_ms);
  }
  if (!browserContinuity) throw new Error("Voice Lab did not produce a current post-boot/post-replay browser continuity proof within the bounded controller deadline.");
  if (browserContinuity.run_id_sha256 !== sha256(controller.run.run_id) || browserContinuity.restart_request_id_sha256 !== sha256(restartRequestId)
    || browserContinuity.operation_id_sha256 !== sha256(controller.operation.operation_id) || browserContinuity.after_boot_id_sha256 !== afterVersion.boot_id_sha256
    || browserContinuity.browser_worker_id_sha256 !== controller.browser.worker_id_sha256 || browserContinuity.browser_lease_epoch !== controller.browser.lease_epoch) {
    throw new Error("Voice Lab browser continuity proof did not bind the exact governed restart/run/operation/lease.");
  }
  const continuityObservedAt = now();

  const localUnsigned = {
    schema: "sophia_voice_lab_d02_render_controller_receipt_v1" as const,
    receipt_id: restartRequestId,
    restart_request_id: restartRequestId,
    run_id: controller.run.run_id,
    test_run_id_sha256: controller.run.test_run_id_sha256,
    environment: controller.run.environment,
    expected_deployment: controller.run.expected_deployment,
    authority: "deployment_control" as const,
    issuer: input.publicConfig.deployment_control.issuer,
    subject: input.publicConfig.deployment_control.subject,
    authority_key_id: input.publicConfig.deployment_control.key_id,
    audience: "sophia-voice-lab-deployment-controller-receipt" as const,
    render: {
      service_id_sha256: sha256(controller.render_service_id),
      before_service_response_sha256: before.serviceResponseSha256,
      after_service_response_sha256: after.serviceResponseSha256,
      before_deploy_id_sha256: sha256(before.deployId),
      after_deploy_id_sha256: sha256(after.deployId),
      before_deploy_response_sha256: before.deployResponseSha256,
      after_deploy_response_sha256: after.deployResponseSha256,
      before_instance_set_sha256: before.instanceSetSha256,
      after_instance_set_sha256: after.instanceSetSha256,
      restart_request_sha256: renderRequestSha256,
      restart_accepted_response_sha256: accepted.responseSha256,
      restart_http_status: 200 as const,
      restart_requested_at: renderRequestedAt.toISOString(),
      restart_accepted_at: renderAcceptedAt.toISOString(),
      deploy_started_at: after.deployStartedAt,
      deploy_settled_at: deploySettledAt,
      provider_action_state: "settled_live" as const,
    },
    service: {
      before_boot_id_sha256: beforeVersion.boot_id_sha256,
      after_boot_id_sha256: afterVersion.boot_id_sha256,
      before_instance_id_sha256: beforeVersion.instance_id_sha256,
      after_instance_id_sha256: afterVersion.instance_id_sha256,
      before_version_response_sha256: beforeVersion.version_response_sha256,
      after_version_response_sha256: afterVersion.version_response_sha256,
      exact_candidate_sha_preserved: true as const,
    },
    browser: { continuity_proof: browserContinuity },
    replay: {
      operation_id: controller.operation.operation_id,
      request_sha256: controller.operation.request_sha256,
      original_receipt_sha256: controller.operation.durable_receipt_sha256,
      replay_receipt_sha256: controller.operation.durable_receipt_sha256,
      replay_response_sha256: replay.responseSha256,
      observed_at: replayObservedAt.toISOString(),
      duplicate_injection_count: 0 as const,
    },
    nonce: randomBytes(32).toString("base64url"),
    issued_at: continuityObservedAt.toISOString(),
    expires_at: new Date(continuityObservedAt.getTime() + 900_000).toISOString(),
    signature_algorithm: "ed25519-sha256-canonical-request-v1" as const,
  };
  const localControllerReceipt = await signD02LocalReceipt(localUnsigned, input.publicConfig, input.deploymentPrivateKeyPath);
  D02LocalControllerReceiptSchema.parse(localControllerReceipt);
  const localControllerReceiptSha256 = canonicalRequestHash(localControllerReceipt);
  await input.checkpoint?.({ phase: "render_settled", receipt: localControllerReceipt, receipt_sha256: localControllerReceiptSha256 });

  // The final server proof is derived only after the provider action, exact
  // service identities, unchanged browser lease, and MCP replay have settled.
  const finalEvidence = {
    kind: "d02_api_process_restart" as const,
    authority: "deployment_control" as const,
    operation_id: controller.operation.operation_id,
    request_sha256: controller.operation.request_sha256,
    idempotency_key_sha256: controller.operation.idempotency_key_sha256,
    before_boot_id_sha256: beforeVersion.boot_id_sha256,
    after_boot_id_sha256: afterVersion.boot_id_sha256,
    restart_request_id_sha256: sha256(restartRequestId),
    before_instance_id_sha256: beforeVersion.instance_id_sha256,
    after_instance_id_sha256: afterVersion.instance_id_sha256,
    before_version_response_sha256: beforeVersion.version_response_sha256,
    after_version_response_sha256: afterVersion.version_response_sha256,
    original_receipt_sha256: controller.operation.durable_receipt_sha256,
    replay_receipt_sha256: controller.operation.durable_receipt_sha256,
    browser_worker_id_sha256: browserContinuity.browser_worker_id_sha256,
    browser_lease_epoch: browserContinuity.browser_lease_epoch,
    canonical_session_id_sha256: controller.product.canonical_session_id_sha256,
    thread_id_sha256: controller.product.thread_id_sha256,
    provider_session_id_sha256: controller.product.provider_session_id_sha256,
    provider_connection_epoch: controller.product.provider_connection_epoch,
    restart_requested_at: restartRequestedAt.toISOString(),
    new_process_started_at: instanceCreatedAt.toISOString(),
    replay_observed_at: replayObservedAt.toISOString(),
    provider_restart_request_sha256: renderRequestSha256,
    provider_restart_accepted_response_sha256: accepted.responseSha256,
    local_controller_receipt_sha256: localControllerReceiptSha256,
    browser_continuity_proof: browserContinuity,
    old_process_exited: true as const,
    new_process_started: true as const,
    browser_worker_continuity: true as const,
    duplicate_injection_count: 0 as const,
  };
  const finalNow = now();
  const finalClaim = await signExternalClaim(newUnsignedClaim({ run: controller.run, authority: "deployment_control", publicConfig: input.publicConfig, evidence: finalEvidence, now: finalNow }), input.publicConfig, input.deploymentPrivateKeyPath, finalNow);
  const finalReceipt = await postAttestationAndVerifyReplay({ baseUrl: controller.voice_lab_url, claim: finalClaim, publicConfig: input.publicConfig, transportTokens: input.transportTokens, fetchImpl, ...(input.allowHttpForTest === undefined ? {} : { allowHttpForTest: input.allowHttpForTest }) });
  await input.checkpoint?.({ phase: "final_attached", claim: finalClaim, receipt: finalReceipt });
  return {
    command_claim: commandClaim,
    command_receipt: commandReceipt,
    local_controller_receipt: localControllerReceipt,
    local_controller_receipt_sha256: localControllerReceiptSha256,
    final_claim: finalClaim,
    final_receipt: finalReceipt,
    provider_action: {
      service_id_sha256: sha256(controller.render_service_id),
      request_sha256: renderRequestSha256,
      accepted_response_sha256: accepted.responseSha256,
      before_deploy_id_sha256: sha256(before.deployId),
      after_deploy_id_sha256: sha256(after.deployId),
      before_instance_set_sha256: before.instanceSetSha256,
      after_instance_set_sha256: after.instanceSetSha256,
      state: "settled_live",
    },
  };
}

async function readBrowserContinuity(input: {
  baseUrl: string;
  bearer: string;
  runId: string;
  restartRequestIdSha256: string;
  operationId: string;
  afterBootIdSha256: string;
  fetchImpl: typeof fetch;
  allowHttpForTest: boolean;
}): Promise<D02BrowserContinuityProof> {
  const url = new URL(input.baseUrl);
  if (url.protocol !== "https:" && !(input.allowHttpForTest && url.protocol === "http:")) throw new Error("D02 browser continuity proof requires HTTPS.");
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("Voice Lab controller URL must be a bare origin.");
  url.pathname = "/internal/voice-lab/d02/browser-continuity";
  const requestBody = { run_id: input.runId, restart_request_id_sha256: input.restartRequestIdSha256, operation_id: input.operationId, after_boot_id_sha256: input.afterBootIdSha256 };
  const response = await input.fetchImpl(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json", authorization: `Bearer ${input.bearer}`, "content-type": "application/json" }, body: JSON.stringify(requestBody) });
  const body = await readProviderResponse(response);
  if (response.status !== 200) throw new Error(`D02 browser continuity proof is pending (HTTP ${response.status}).`);
  return D02BrowserContinuityProofSchema.parse(body.parsed);
}

async function readVersion(baseUrl: string, fetchImpl: typeof fetch, allowHttpForTest: boolean): Promise<VersionIdentity> {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !(allowHttpForTest && url.protocol === "http:")) throw new Error("Voice Lab version probe requires HTTPS.");
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("Voice Lab controller URL must be a bare origin.");
  url.pathname = "/version";
  const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  const body = await readProviderResponse(response);
  if (response.status !== 200 || !body.parsed || typeof body.parsed !== "object") throw new Error(`Voice Lab version probe failed (HTTP ${response.status}).`);
  const record = body.parsed as Record<string, unknown>;
  const identity: VersionIdentity = {
    service: record.service as VersionIdentity["service"],
    commit_sha: String(record.commit_sha ?? ""),
    boot_id_sha256: String(record.boot_id_sha256 ?? ""),
    instance_id_sha256: String(record.instance_id_sha256 ?? ""),
    version_response_sha256: String(record.version_response_sha256 ?? ""),
  };
  if (identity.service !== "sophia-voice-lab-mcp" || !/^[a-f0-9]{40}$/.test(identity.commit_sha) || ![identity.boot_id_sha256, identity.instance_id_sha256, identity.version_response_sha256].every((value) => /^[a-f0-9]{64}$/.test(value))) throw new Error("Voice Lab version response has an invalid identity contract.");
  const expectedHash = canonicalRequestHash({ service: identity.service, commit_sha: identity.commit_sha, boot_id_sha256: identity.boot_id_sha256, instance_id_sha256: identity.instance_id_sha256 });
  if (identity.version_response_sha256 !== expectedHash) throw new Error("Voice Lab version response self-hash is invalid.");
  return identity;
}

function assertCandidateVersion(version: VersionIdentity, expectedCandidate: string): void {
  if (version.commit_sha !== expectedCandidate) throw new Error("Voice Lab controller observed a deployment SHA different from the governed candidate.");
}

async function readRenderSnapshot(controller: D02RenderControllerInput, bearer: string, fetchImpl: typeof fetch, requestedAfter: Date | null): Promise<RenderSnapshot> {
  const base = `${controller.render_api_origin}/v1/services/${encodeURIComponent(controller.render_service_id)}`;
  const [service, deploys, instances] = await Promise.all([
    renderRequest({ url: new URL(base), method: "GET", bearer, fetchImpl }),
    renderRequest({ url: new URL(`${base}/deploys?limit=20`), method: "GET", bearer, fetchImpl }),
    renderRequest({ url: new URL(`${base}/instances`), method: "GET", bearer, fetchImpl }),
  ]);
  if (service.status !== 200 || deploys.status !== 200 || instances.status !== 200) throw new Error("Render read-only service/deploy/instance preflight failed.");
  const serviceRecord = unwrapNamedRecord(service.parsed, "service");
  const serviceId = String(serviceRecord.id ?? "");
  if (serviceId !== controller.render_service_id) throw new Error("Render service preflight returned the wrong service ID.");
  const deployRecords = unwrapList(deploys.parsed, "deploy").map((item) => normalizeDeploy(item)).filter((item) => item !== null) as Array<ReturnType<typeof normalizeDeploy> & {}>;
  const threshold = requestedAfter?.getTime() ?? Number.NEGATIVE_INFINITY;
  const deploy = deployRecords.find((item) => item.createdAt.getTime() >= threshold && item.status === "live") ?? deployRecords.find((item) => item.status === "live") ?? null;
  if (!deploy) throw new Error("Render deploy list has no exact live deploy record.");
  const instanceRecords = unwrapList(instances.parsed, "instance").map((item) => normalizeInstance(item)).filter((item) => item !== null) as Array<ReturnType<typeof normalizeInstance> & {}>;
  const instanceIds = instanceRecords.map((item) => item.id).sort();
  if (instanceIds.length < 1 || new Set(instanceIds).size !== instanceIds.length) throw new Error("Render instance list is empty or duplicated.");
  const newest = [...instanceRecords].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0]!;
  return {
    serviceResponseSha256: service.responseSha256,
    deployResponseSha256: deploys.responseSha256,
    instanceResponseSha256: instances.responseSha256,
    serviceId,
    deployId: deploy.id,
    deployStatus: deploy.status,
    deployStartedAt: deploy.startedAt.toISOString(),
    deploySettledAt: deploy.finishedAt?.toISOString() ?? (deploy.status === "live" ? deploy.updatedAt.toISOString() : null),
    instanceIds,
    instanceSetSha256: canonicalRequestHash(instanceIds.map((id) => sha256(id)).sort()),
    newInstanceCreatedAt: newest.createdAt.toISOString(),
  };
}

async function renderRequest(input: { url: URL; method: "GET" | "POST"; bearer: string; fetchImpl: typeof fetch; body?: string }): Promise<{ status: number; responseSha256: string; parsed: unknown }> {
  if (input.url.origin !== "https://api.render.com" || !input.url.pathname.startsWith("/v1/services/") || input.url.username || input.url.password || input.url.hash) throw new Error("Render request escaped the exact API/service allowlist.");
  const response = await input.fetchImpl(input.url, {
    method: input.method,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { accept: "application/json", authorization: `Bearer ${input.bearer}`, ...(input.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(input.body === undefined ? {} : { body: input.body }),
  });
  const body = await readProviderResponse(response);
  return { status: response.status, responseSha256: body.responseSha256, parsed: body.parsed };
}

async function readProviderResponse(response: Response): Promise<{ responseSha256: string; parsed: unknown }> {
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("Provider response exceeded the controller byte cap.");
  let parsed: unknown = null;
  if (buffer.byteLength > 0) {
    try { parsed = JSON.parse(buffer.toString("utf8")) as unknown; }
    catch { parsed = { non_json_response_sha256: sha256(buffer), byte_length: buffer.byteLength }; }
  }
  return { responseSha256: sha256(buffer), parsed };
}

function unwrapNamedRecord(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Render ${key} response is not an object.`);
  const record = value as Record<string, unknown>;
  const nested = record[key];
  return nested && typeof nested === "object" && !Array.isArray(nested) ? nested as Record<string, unknown> : record;
}

function unwrapList(value: unknown, key: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`Render ${key} list response is not an array.`);
  return value.map((item) => unwrapNamedRecord(item, key));
}

function normalizeDeploy(record: Record<string, unknown>): { id: string; status: string; createdAt: Date; startedAt: Date; updatedAt: Date; finishedAt: Date | null } | null {
  const id = String(record.id ?? "");
  const status = String(record.status ?? "");
  if (!/^dep-[0-9a-z]{20}$/.test(id) || !/^[a-z_]+$/.test(status)) return null;
  const createdAt = exactDate(record.createdAt ?? record.created_at);
  const startedAt = exactDate(record.startedAt ?? record.started_at ?? record.createdAt ?? record.created_at);
  const updatedAt = exactDate(record.updatedAt ?? record.updated_at ?? record.finishedAt ?? record.finished_at ?? record.createdAt ?? record.created_at);
  const finishedRaw = record.finishedAt ?? record.finished_at;
  const finishedAt = finishedRaw === null || finishedRaw === undefined ? null : exactDate(finishedRaw);
  return { id, status, createdAt, startedAt, updatedAt, finishedAt };
}

function normalizeInstance(record: Record<string, unknown>): { id: string; createdAt: Date } | null {
  const id = String(record.id ?? record.instanceId ?? record.instance_id ?? "");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) return null;
  return { id, createdAt: exactDate(record.createdAt ?? record.created_at ?? record.startedAt ?? record.started_at) };
}

function exactDate(value: unknown): Date {
  if (typeof value !== "string") throw new Error("Render provider receipt lacks a required timestamp.");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("Render provider receipt contains an invalid timestamp.");
  return parsed;
}
