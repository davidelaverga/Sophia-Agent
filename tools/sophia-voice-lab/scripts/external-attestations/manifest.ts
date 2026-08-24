import { z } from "zod";

import { canonicalRequestHash, sha256 } from "../../src/security.js";
import { ExternalAttestationSchema } from "../../src/service.js";
import type { SignedExternalAttestation } from "./contracts.js";
import { VerifiedAttestationReceiptSchema, type VerifiedAttestationReceipt } from "./http.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ManifestSchema = z.object({
  contract_version: z.literal("sophia.voice-lab.evidence.v1"),
  schema_version: z.literal("sophia.voice-lab.evidence.v1"),
  manifest_id: z.string().uuid(),
  run_id: z.string().uuid(),
  test_run_id: z.string().uuid(),
  cleanup_obligation: z.object({ cleanup_obligation_id_sha256: Sha256Schema, raw_identifier_excluded: z.literal(true) }).strict(),
  environment: z.enum(["production", "staging"]),
  scenario: z.object({ id: z.string(), version: z.string() }).passthrough(),
  deployment_identity: z.object({ expected: z.record(z.string(), z.string()), observed: z.record(z.string(), z.string()) }).passthrough(),
  certification: z.object({ revision_seq: z.number().int().positive(), current_manifest_pointer_advances_append_only: z.literal(true) }).passthrough(),
  external_attestations: z.array(z.object({
    kind: z.string(),
    event_seq: z.number().int().positive(),
    content_sha256: Sha256Schema,
    authority: z.string(),
    issuer: z.string(),
    authority_key_id: z.string(),
    jti_sha256: Sha256Schema,
    request_argument_sha256: Sha256Schema,
  }).strict()),
}).passthrough();

export interface VerifiedManifestRevision {
  manifest_id: string;
  manifest_sha256: string;
  revision_seq: number;
  prior_revision_seq: number | null;
  attestation_event_seq: number;
  attestation_content_sha256: string;
  append_only_revision_verified: true;
}

export function verifyManifestRevision(input: {
  manifestBytes: Buffer;
  expectedManifestSha256?: string;
  priorManifestBytes?: Buffer;
  claim: SignedExternalAttestation;
  receipt: VerifiedAttestationReceipt;
}): VerifiedManifestRevision {
  const claim = ExternalAttestationSchema.parse(input.claim);
  const receipt = VerifiedAttestationReceiptSchema.parse(input.receipt);
  if (receipt.attestation_id !== claim.attestation_id || receipt.attestation_kind !== claim.evidence.kind || !receipt.immutable || !receipt.exact_replay_verified) throw new Error("Verified POST receipt does not bind the exact signed attestation.");
  let raw: unknown;
  try { raw = JSON.parse(input.manifestBytes.toString("utf8")); }
  catch { throw new Error("Evidence manifest is not valid JSON."); }
  const manifest = ManifestSchema.parse(raw);
  const manifestSha256 = sha256(input.manifestBytes);
  if (input.expectedManifestSha256 && input.expectedManifestSha256 !== manifestSha256) throw new Error("Evidence manifest bytes do not match the exported manifest SHA-256.");
  if (manifest.run_id !== claim.run_id || manifest.environment !== claim.environment || manifest.scenario.id !== claim.scenario_id || manifest.scenario.version !== claim.scenario_version || manifest.cleanup_obligation.cleanup_obligation_id_sha256 !== claim.cleanup_obligation_id_sha256) throw new Error("Evidence manifest does not bind the signed run/scenario/cleanup claim.");
  if (sha256(manifest.test_run_id) !== claim.test_run_id_sha256 || canonicalRequestHash(manifest.deployment_identity.expected) !== canonicalRequestHash(claim.expected_deployment)) throw new Error("Evidence manifest test-run or deployment binding differs from the signed claim.");
  const attestation = manifest.external_attestations.filter((entry) => entry.kind === claim.evidence.kind && entry.event_seq === receipt.event_seq);
  if (attestation.length !== 1) throw new Error("Evidence manifest does not contain exactly one matching external attestation revision entry.");
  const entry = attestation[0]!;
  if (entry.content_sha256 !== receipt.content_sha256 || entry.authority !== claim.evidence.authority || entry.issuer !== claim.issuer || entry.authority_key_id !== claim.authority_key_id || entry.jti_sha256 !== sha256(claim.jti) || entry.request_argument_sha256 !== canonicalRequestHash(claim)) throw new Error("Manifest attestation projection does not match the signed claim and immutable POST receipt.");
  if (manifest.certification.revision_seq < receipt.event_seq) throw new Error("Manifest revision predates the attached attestation event.");

  let priorRevisionSeq: number | null = null;
  if (input.priorManifestBytes) {
    let priorRaw: unknown;
    try { priorRaw = JSON.parse(input.priorManifestBytes.toString("utf8")); }
    catch { throw new Error("Prior evidence manifest is not valid JSON."); }
    const prior = ManifestSchema.parse(priorRaw);
    priorRevisionSeq = prior.certification.revision_seq;
    if (prior.run_id !== manifest.run_id || prior.manifest_id === manifest.manifest_id || prior.certification.revision_seq >= manifest.certification.revision_seq || sha256(input.priorManifestBytes) === manifestSha256) throw new Error("Manifest did not advance through a distinct append-only revision.");
    if (prior.external_attestations.some((item) => item.kind === claim.evidence.kind)) throw new Error("Prior manifest already contained the claimed source-specific attestation slot.");
  }
  return {
    manifest_id: manifest.manifest_id,
    manifest_sha256: manifestSha256,
    revision_seq: manifest.certification.revision_seq,
    prior_revision_seq: priorRevisionSeq,
    attestation_event_seq: receipt.event_seq,
    attestation_content_sha256: receipt.content_sha256,
    append_only_revision_verified: true,
  };
}
