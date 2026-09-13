import { describe, expect, it } from "vitest";
import { classifyRetainedRecoveryResponse, RetainedRecoveryOnlyError } from "../src/retained-recovery-response.js";
import { canonicalRequestHash, sha256 } from "../src/security.js";

describe("retained recovery response classification", () => {
  const claim = { evidence: { kind: "d02_browser_worker_loss" }, signature: "synthetic-claim" };
  const response = { contract_version: "sophia.voice-lab.v1", request_id: "00000000-0000-4000-8000-000000000001",
    run_id: null, test_run_id: null, event_cursor: null, status: "ok",
    data: { proof_status: "retained_recovery_facts_only", signed_claim_sha256: canonicalRequestHash(claim),
      raw_evidence_purged: true, certification_available: false, control_binding_sha256: sha256("control"),
      owner_death_proof_sha256: sha256("owner"), provider_settlement_proof_sha256: sha256("provider"),
      live_cleanup_complete: false, remote_purge_complete: false } };
  it("returns a distinct non-certification outcome with content-free response binding", () => {
    const result = classifyRetainedRecoveryResponse(response, claim, sha256("wire-bytes"));
    expect(result).toBeInstanceOf(RetainedRecoveryOnlyError);
    expect(result).toMatchObject({ code: "RETAINED_RECOVERY_ONLY_NOT_CERTIFIED", responseSha256: sha256("wire-bytes"), facts: response.data });
    expect(classifyRetainedRecoveryResponse({ status: "completed", data: {} }, claim, sha256("other"))).toBeNull();
  });
  it("rejects mismatched claim, certification upgrade, raw run and invented event", () => {
    for (const raw of [
      { ...response, data: { ...response.data, signed_claim_sha256: sha256("foreign") } },
      { ...response, data: { ...response.data, certification_available: true } },
      { ...response, run_id: response.request_id }, { ...response, event_cursor: 1 },
      { ...response, data: { ...response.data, event_seq: 1 } },
    ]) expect(() => classifyRetainedRecoveryResponse(raw, claim, sha256("wire"))).toThrow();
    expect(() => classifyRetainedRecoveryResponse(response, { evidence: { kind: "p01_platform_plugin_task" } }, sha256("wire"))).toThrow();
  });
});
