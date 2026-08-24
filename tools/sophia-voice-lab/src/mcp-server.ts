import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { VoiceLabLedger } from "./ledger.js";
import { VoiceLabError, labError } from "./domain.js";
import type { AuthenticatedCaller } from "./security.js";
import { canonicalRequestHash, requireScope, sha256 } from "./security.js";
import { errorEnvelope, toolInputSchemas, type VoiceLabService } from "./service.js";

const EnvelopeSchema = z.object({
  contract_version: z.literal("sophia.voice-lab.v1"),
  request_id: z.string().uuid(),
  test_run_id: z.string().uuid().nullable(),
  run_id: z.string().uuid().nullable(),
  operation_id: z.string().uuid().nullable(),
  suite_run_id: z.string().uuid().nullable(),
  status: z.enum(["ok", "accepted", "running", "completed", "failed", "timeout", "unavailable"]),
  event_cursor: z.number().int().nonnegative().nullable(),
  deployment_identity: z.object({ expected: z.record(z.string(), z.string()), observed: z.record(z.string(), z.string()) }).strict(),
  session_id: z.string().nullable(),
  thread_id: z.string().nullable(),
  provider_session_id: z.string().nullable(),
  trace_id: z.string().nullable(),
  provider_connection_epoch: z.number().int().nonnegative().nullable(),
  turn_id: z.string().nullable(),
  evidence_references: z.array(z.object({ kind: z.string(), resource_id: z.string(), sha256: z.string(), content_type: z.string().optional(), byte_length: z.number().optional(), expires_at: z.string().optional() }).strict()),
  retryability: z.enum(["retryable", "not_retryable", "unknown"]),
  error_class: z.string().nullable(),
  observed_at: z.string(),
  cursor: z.object({ after: z.number().nullable(), latest: z.number().nullable() }).strict(),
  deployment: z.object({ expected: z.record(z.string(), z.string()), observed: z.record(z.string(), z.string()) }).strict(),
  joins: z.object({
    test_run_id: z.string().nullable(),
    canonical_session_id: z.string().nullable(),
    thread_id: z.string().nullable(),
    provider_session_id: z.string().nullable(),
    trace_id: z.string().nullable(),
    provider_connection_epoch: z.number().int().nonnegative().nullable(),
    turn_id: z.string().nullable(),
    availability: z.object({ canonical_session: z.enum(["available", "not_yet_observed", "owning_contract_unavailable"]), thread: z.enum(["available", "not_yet_observed", "owning_contract_unavailable"]), provider_session: z.enum(["available", "not_yet_observed", "owning_contract_unavailable"]), trace: z.enum(["available", "trace_unavailable"]), provider_epoch: z.enum(["available", "not_yet_observed", "owning_contract_unavailable"]), turn: z.enum(["available", "not_yet_observed", "owning_contract_unavailable"]) }).strict(),
  }).strict(),
  verdicts: z.object({ harness: z.string(), product: z.string(), provider: z.string(), auth: z.string(), evidence: z.string() }).strict().nullable(),
  warnings: z.array(z.object({ code: z.string(), message: z.string() }).strict()),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), category: z.string(), details: z.record(z.string(), z.unknown()).optional() }).strict().nullable(),
  data: z.record(z.string(), z.unknown()),
}).strict();

type Handler = (caller: AuthenticatedCaller, input: unknown) => Promise<import("./domain.js").LabEnvelope>;

const DEFINITIONS: Array<{
  name: keyof typeof toolInputSchemas;
  title: string;
  description: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean; idempotentHint?: boolean };
  scopes: string[];
  invoke: (service: VoiceLabService) => Handler;
}> = [
  { name: "get_capabilities", title: "Get Sophia Voice Lab capabilities", description: "Read the exact server version, authorized test capabilities, scenarios, fixtures, limits, and evidence contract before starting a run.", scopes: ["voice_lab:read"], annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }, invoke: (s) => s.getCapabilities.bind(s) },
  { name: "start_voice_run", title: "Start deployed Sophia voice run", description: "Durably reserve an isolated synthetic run and asynchronously open the ordinary deployed Sophia UI only after authorization and exact-build checks.", scopes: ["voice_lab:run"], annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true }, invoke: (s) => s.startVoiceRun.bind(s) },
  { name: "speak", title: "Schedule synthetic speech", description: "Inject allowlisted fixture or bounded server-side TTS through the page-owned WebAudio microphone seam. Returns only after a durable page scheduling receipt or typed bounded timeout.", scopes: ["voice_lab:run"], annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true }, invoke: (s) => s.speak.bind(s) },
  { name: "wait_for_turn", title: "Wait for one voice observation", description: "Boundedly wait after a monotonic event cursor for one exact transcription, playback, tool, task, UI, session, or operation observation.", scopes: ["voice_lab:read"], annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }, invoke: (s) => s.waitForTurn.bind(s) },
  { name: "inspect_voice_run", title: "Inspect voice run", description: "Read durable run state, separate verdicts, joins, and gap-free event records after a cursor without controlling Sophia.", scopes: ["voice_lab:read"], annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }, invoke: (s) => s.inspectVoiceRun.bind(s) },
  { name: "barge_in", title: "Schedule timed barge-in", description: "Schedule synthetic input relative to a proven output-playback-start receipt, through the same deployed voice route.", scopes: ["voice_lab:run"], annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true }, invoke: (s) => s.bargeIn.bind(s) },
  { name: "force_socket_rotation", title: "Force allowlisted socket rotation", description: "Capability-gated fault action that closes only the latest allowlisted provider socket after validating the product provider epoch, then observes real rotation/restoration.", scopes: ["voice_lab:fault"], annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: true }, invoke: (s) => s.forceSocketRotation.bind(s) },
  { name: "end_voice_run", title: "End and finalize voice run", description: "Idempotently use the ordinary UI to end the run, require canonical finalization, clean browser/provider resources, and create durable evidence.", scopes: ["voice_lab:run"], annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: true }, invoke: (s) => s.endVoiceRun.bind(s) },
  { name: "export_voice_evidence", title: "Export durable voice evidence", description: "Read the restart-safe Postgres evidence manifest and resource references. LangSmith is optional and fail-open.", scopes: ["voice_lab:read"], annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }, invoke: (s) => s.exportVoiceEvidence.bind(s) },
  { name: "run_regression_suite", title: "Run voice regression suite", description: "Durably schedule individually inspectable scenario runs with bounded concurrency; product failures do not hide later children.", scopes: ["voice_lab:run"], annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true }, invoke: (s) => s.runRegressionSuite.bind(s) },
  { name: "get_suite_run", title: "Inspect regression suite", description: "Read the durable suite and every child run state/verdict without mutating execution.", scopes: ["voice_lab:read"], annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }, invoke: (s) => s.getSuiteRun.bind(s) },
];

export function createVoiceLabMcpServer(
  service: VoiceLabService,
  ledger: VoiceLabLedger,
  caller: AuthenticatedCaller,
  oauthChallenge?: (scopes: readonly string[], error: "invalid_token" | "insufficient_scope") => string,
  requestContext?: { requestIdHash: string; clientRequestIdHash: string | null },
): McpServer {
  const server = new McpServer(
    { name: "sophia-voice-lab", version: service.config.serviceVersion },
    { instructions: "First call get_capabilities. Use exact deployment SHAs and unique idempotency keys. Drive only the dedicated synthetic principal. Speak succeeds only with a page scheduling receipt. Inspect by cursor; end every run; then export evidence. Never infer product success from harness success." },
  );
  for (const definition of DEFINITIONS) {
    const invoke = definition.invoke(service);
    const securitySchemes = [{ type: "oauth2", scopes: definition.scopes }];
    server.registerTool(definition.name, {
      title: definition.title,
      description: definition.description,
      inputSchema: toolInputSchemas[definition.name] as any,
      outputSchema: EnvelopeSchema,
      annotations: definition.annotations,
      securitySchemes,
      _meta: { securitySchemes },
    } as any, async (input: unknown) => {
      const argumentHash = canonicalRequestHash(input ?? null);
      const auditRunId = await ownedAuditRunId(ledger, input, caller);
      try {
        const result = await invoke(caller, input);
        const responseSha256 = canonicalRequestHash(result);
        const responseRunId = typeof result.run_id === "string" && /^[0-9a-f-]{36}$/i.test(result.run_id) ? result.run_id : auditRunId;
        const operationId = typeof result.operation_id === "string" && /^[0-9a-f-]{36}$/i.test(result.operation_id) ? result.operation_id : null;
        const authDetail = {
          authorization_kind: caller.authorizationKind ?? "unknown",
          oauth_client_id_sha256: caller.authorizationKind === "oauth" && caller.clientId ? sha256(caller.clientId) : null,
          oauth_token_id_sha256: caller.authorizationKind === "oauth" && caller.tokenId ? sha256(caller.tokenId) : null,
        };
        const manifestId = typeof result.data.manifest_id === "string" && /^[0-9a-f-]{36}$/i.test(result.data.manifest_id) ? result.data.manifest_id : null;
        const manifestSha256 = typeof result.data.manifest_sha256 === "string" && /^[a-f0-9]{64}$/.test(result.data.manifest_sha256) ? result.data.manifest_sha256 : null;
        const detail = {
          status: result.status,
          error_class: result.error_class,
          response_sha256: responseSha256,
          result_request_id_sha256: sha256(result.request_id),
          request_id_hash: requestContext?.requestIdHash ?? null,
          client_request_id_hash: requestContext?.clientRequestIdHash ?? null,
          operation_id_sha256: operationId ? sha256(operationId) : null,
          run_id_sha256: responseRunId ? sha256(responseRunId) : null,
          operation_state: typeof result.data.operation_state === "string" ? result.data.operation_state : null,
          run_state: typeof result.data.run_state === "string" ? result.data.run_state : null,
          condition_satisfied: result.data.condition_satisfied === true,
          terminal: result.data.terminal === true,
          cleanup_complete: result.data.cleanup_complete === true,
          evidence_state: typeof result.data.evidence_state === "string" ? result.data.evidence_state : null,
          manifest_id_sha256: manifestId ? sha256(manifestId) : null,
          manifest_sha256: manifestSha256,
          replay: result.data.replay === true,
          ...authDetail,
        };
        // This content-free receipt is durable before the SDK writes response
        // bytes, so a client-side disconnect cannot erase accepted/replayed
        // operation truth. It is retained with the owning run.
        await ledger.recordAuthAudit({ runId: responseRunId, callerId: caller.subject, action: "mcp.tool_response", argumentHash, outcome: result.status === "failed" ? "denied" : "allowed", detail: { tool: definition.name, ...detail }, observedAt: new Date() });
        await ledger.recordAuthAudit({ runId: responseRunId, callerId: caller.subject, action: `tool:${definition.name}`, argumentHash, outcome: result.status === "failed" ? "denied" : "allowed", detail, observedAt: new Date() });
        return { content: [{ type: "text" as const, text: summarize(result) }], structuredContent: result as unknown as Record<string, unknown>, isError: result.status === "failed" };
      } catch (error) {
        const contextRun = auditRunId ? await ledger.getRun(auditRunId) : null;
        const result = errorEnvelope(error, contextRun?.callerId === caller.subject ? contextRun : undefined);
        await ledger.recordAuthAudit({ runId: auditRunId, callerId: caller.subject, action: `tool:${definition.name}`, argumentHash, outcome: "denied", detail: { status: result.status, error_class: result.error_class, request_id_hash: requestContext?.requestIdHash ?? null, client_request_id_hash: requestContext?.clientRequestIdHash ?? null }, observedAt: new Date() });
        const challenge = oauthChallenge && result.error?.category === "authorization" ? oauthChallenge(definition.scopes, result.error.code === "SCOPE_REQUIRED" ? "insufficient_scope" : "invalid_token") : null;
        return { content: [{ type: "text" as const, text: `${result.error_class}: ${result.error?.message ?? "Voice Lab request failed."}` }], structuredContent: result as unknown as Record<string, unknown>, isError: true, ...(challenge ? { _meta: { "mcp/www_authenticate": [challenge] } } : {}) };
      }
    });
  }
  // SDK 1.30 still serializes only `_meta.securitySchemes`; the registered-app
  // contract additionally requires the same declaration at the tool's top
  // level. Replace only tools/list with the forward-compatible wire shape;
  // registered call handlers and validation remain owned by McpServer.
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: DEFINITIONS.map((definition) => {
      const securitySchemes = [{ type: "oauth2", scopes: definition.scopes }];
      return {
        name: definition.name,
        title: definition.title,
        description: definition.description,
        inputSchema: z.toJSONSchema(toolInputSchemas[definition.name] as any) as any,
        outputSchema: z.toJSONSchema(EnvelopeSchema) as any,
        annotations: definition.annotations,
        securitySchemes,
        _meta: { securitySchemes },
      };
    }),
  } as any));
  server.registerResource("voice-evidence", new ResourceTemplate("voice-lab://evidence/{manifestId}", { list: undefined }), { title: "Sophia Voice Lab evidence manifest", description: "Durable evidence JSON, authorized to the originating caller.", mimeType: "application/json" }, async (uri, variables) => {
    requireScope(caller, "voice_lab:read");
    const artifact = await ledger.getArtifact(String(variables.manifestId));
    await assertArtifactOwner(ledger, artifact, caller);
    return { contents: [{ uri: uri.toString(), mimeType: "application/json", text: artifact!.bytes.toString("utf8") }] };
  });
  server.registerResource("voice-artifact", new ResourceTemplate("voice-lab://artifact/{artifactId}", { list: undefined }), { title: "Sophia Voice Lab evidence artifact", description: "Capped durable evidence artifact, authorized to the originating caller." }, async (uri, variables) => {
    requireScope(caller, "voice_lab:read");
    const artifact = await ledger.getArtifact(String(variables.artifactId));
    await assertArtifactOwner(ledger, artifact, caller);
    return { contents: [{ uri: uri.toString(), mimeType: artifact!.contentType, blob: artifact!.bytes.toString("base64") }] };
  });
  server.registerResource("voice-suite-evidence", new ResourceTemplate("voice-lab://suite-evidence/{manifestId}", { list: undefined }), { title: "Sophia Voice Lab aggregate suite evidence", description: "Immutable aggregate suite evidence, authorized to the originating caller.", mimeType: "application/json" }, async (uri, variables) => {
    requireScope(caller, "voice_lab:read");
    const evidence = await ledger.getSuiteEvidenceByManifestId(String(variables.manifestId));
    if (!evidence) throw new VoiceLabError(labError("EVIDENCE_NOT_FOUND", "Suite evidence resource was not found.", "validation"));
    const suite = await ledger.getSuite(evidence.suiteId);
    if (!suite || suite.callerId !== caller.subject) throw new VoiceLabError(labError("EVIDENCE_NOT_FOUND", "Suite evidence resource was not found.", "validation"));
    return { contents: [{ uri: uri.toString(), mimeType: "application/json", text: evidence.bytes.toString("utf8") }] };
  });
  return server;
}

async function ownedAuditRunId(ledger: VoiceLabLedger, input: unknown, caller: AuthenticatedCaller): Promise<string | null> {
  const candidate = input && typeof input === "object" && typeof (input as Record<string, unknown>).run_id === "string" ? String((input as Record<string, unknown>).run_id) : null;
  if (!candidate || !/^[a-f0-9-]{36}$/i.test(candidate)) return null;
  const run = await ledger.getRun(candidate);
  return run?.callerId === caller.subject ? candidate : null;
}

async function assertArtifactOwner(ledger: VoiceLabLedger, artifact: Awaited<ReturnType<VoiceLabLedger["getArtifact"]>>, caller: AuthenticatedCaller): Promise<void> {
  if (!artifact) throw new VoiceLabError(labError("EVIDENCE_NOT_FOUND", "Evidence resource was not found.", "validation"));
  const run = await ledger.getRun(artifact.runId);
  if (!run || run.callerId !== caller.subject) throw new VoiceLabError(labError("EVIDENCE_NOT_FOUND", "Evidence resource was not found.", "validation"));
}
function summarize(result: import("./domain.js").LabEnvelope): string { return `Sophia Voice Lab ${result.status}; run=${result.run_id ?? "none"}; operation=${result.operation_id ?? "none"}; cursor=${result.event_cursor ?? "none"}.`; }
