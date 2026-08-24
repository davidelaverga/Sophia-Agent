import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as ed25519Sign,
  verify as ed25519Verify,
  type KeyObject,
} from "node:crypto";

import { canonicalRequestHash, sha256 } from "../../src/security.js";
import {
  AUTHORITY_NAMES,
  AUTHORITY_DEFAULTS,
  D02LocalControllerReceiptSchema,
  D02WorkerTerminationControllerReceiptSchema,
  PublicAuthorityConfigSchema,
  authorityForClaim,
  parseSignedClaim,
  parseUnsignedClaim,
  stripSignature,
  type AuthorityName,
  type D02LocalControllerReceipt,
  type D02WorkerTerminationControllerReceipt,
  type PublicAuthorityConfig,
  type SignedExternalAttestation,
  type UnsignedExternalAttestation,
} from "./contracts.js";
import { assertUnusedAbsolutePaths, readSecureFile, writeNewSecureFile, writeNewSecureJson } from "./secure-files.js";

export interface AuthorityOutputPaths {
  external_mcp_client: string;
  deployment_control: string;
  platform_plugin: string;
}

export interface AuthorityKeyIds {
  external_mcp_client: string;
  deployment_control: string;
  platform_plugin: string;
}

export interface InitializedAuthorityFiles {
  publicConfig: PublicAuthorityConfig;
  publicConfigSha256: string;
  publicKeyFingerprints: Record<AuthorityName, string>;
}

export async function initializeAuthorityFiles(input: {
  publicConfigPath: string;
  transportTokensPath: string;
  privateKeyPaths: AuthorityOutputPaths;
  keyIds: AuthorityKeyIds;
}): Promise<InitializedAuthorityFiles> {
  const outputPaths = [input.publicConfigPath, input.transportTokensPath, ...AUTHORITY_NAMES.map((authority) => input.privateKeyPaths[authority])];
  await assertUnusedAbsolutePaths(outputPaths);
  if (new Set(Object.values(input.keyIds)).size !== AUTHORITY_NAMES.length) throw new Error("Each source authority requires a distinct key ID.");

  const privateKeys = {} as Record<AuthorityName, Buffer>;
  const publicConfig = {} as PublicAuthorityConfig;
  const publicKeyFingerprints = {} as Record<AuthorityName, string>;
  const tokens = {} as Record<AuthorityName, string>;
  try {
    for (const authority of AUTHORITY_NAMES) {
      const keyId = input.keyIds[authority];
      if (!/^[A-Za-z0-9._:-]{8,128}$/.test(keyId)) throw new Error(`Invalid key ID for ${authority}.`);
      const pair = generateKeyPairSync("ed25519");
      const privateDer = pair.privateKey.export({ format: "der", type: "pkcs8" });
      const publicDer = pair.publicKey.export({ format: "der", type: "spki" });
      privateKeys[authority] = Buffer.from(privateDer);
      publicKeyFingerprints[authority] = sha256(Buffer.from(publicDer));
      publicConfig[authority] = {
        ...AUTHORITY_DEFAULTS[authority],
        key_id: keyId,
        public_key_spki_base64: Buffer.from(publicDer).toString("base64"),
      };
      tokens[authority] = randomBytes(48).toString("base64url");
    }
    PublicAuthorityConfigSchema.parse(publicConfig);
    if (new Set(Object.values(publicKeyFingerprints)).size !== AUTHORITY_NAMES.length) throw new Error("Generated Ed25519 keys were not distinct.");
    if (new Set(Object.values(tokens)).size !== AUTHORITY_NAMES.length) throw new Error("Generated transport tokens were not distinct.");

    // Private keys are published first so no public configuration can be
    // installed without all three corresponding custody files existing.
    for (const authority of AUTHORITY_NAMES) await writeNewSecureFile(input.privateKeyPaths[authority], privateKeys[authority]);
    await writeNewSecureJson(input.transportTokensPath, tokens);
    await writeNewSecureJson(input.publicConfigPath, publicConfig);
    return {
      publicConfig,
      publicConfigSha256: canonicalRequestHash(publicConfig),
      publicKeyFingerprints,
    };
  } finally {
    for (const privateKey of Object.values(privateKeys)) privateKey.fill(0);
    for (const authority of AUTHORITY_NAMES) tokens[authority] = "";
  }
}

export async function signExternalClaim(
  raw: unknown,
  publicConfig: PublicAuthorityConfig,
  privateKeyPath: string,
  now = new Date(),
): Promise<SignedExternalAttestation> {
  const unsigned = parseUnsignedClaim(raw, publicConfig, now);
  const authority = authorityForClaim(unsigned);
  const privateKey = await readPrivateKey(privateKeyPath);
  try {
    assertPrivateKeyMatchesAuthority(privateKey, publicConfig[authority]);
    const digest = Buffer.from(canonicalRequestHash(unsigned), "hex");
    const signature = ed25519Sign(null, digest, privateKey).toString("base64url");
    const signed = parseSignedClaim({ ...unsigned, signature }, publicConfig, now);
    verifyExternalClaimSignature(signed, publicConfig);
    return signed;
  } finally {
    // KeyObject owns its native copy; no private bytes are returned or logged.
  }
}

export function verifyExternalClaimSignature(input: SignedExternalAttestation, publicConfig: PublicAuthorityConfig): void {
  const parsed = parseSignedClaim(input, publicConfig);
  const authority = authorityForClaim(parsed);
  const publicKey = createPublicKey({ key: Buffer.from(publicConfig[authority].public_key_spki_base64, "base64"), format: "der", type: "spki" });
  const valid = ed25519Verify(null, Buffer.from(canonicalRequestHash(stripSignature(parsed)), "hex"), publicKey, Buffer.from(parsed.signature, "base64url"));
  if (!valid) throw new Error("External attestation signature verification failed.");
}

export async function signD02LocalReceipt(
  raw: Omit<D02LocalControllerReceipt, "signature">,
  publicConfig: PublicAuthorityConfig,
  privateKeyPath: string,
): Promise<D02LocalControllerReceipt> {
  const authority = publicConfig.deployment_control;
  if (raw.authority !== "deployment_control" || raw.issuer !== authority.issuer || raw.subject !== authority.subject || raw.authority_key_id !== authority.key_id) throw new Error("D02 local receipt authority binding is invalid.");
  const privateKey = await readPrivateKey(privateKeyPath);
  assertPrivateKeyMatchesAuthority(privateKey, authority);
  const signature = ed25519Sign(null, Buffer.from(canonicalRequestHash(raw), "hex"), privateKey).toString("base64url");
  const signed = D02LocalControllerReceiptSchema.parse({ ...raw, signature });
  verifyD02LocalReceipt(signed, publicConfig);
  return signed;
}

export function verifyD02LocalReceipt(input: D02LocalControllerReceipt, publicConfig: PublicAuthorityConfig): void {
  const parsed = D02LocalControllerReceiptSchema.parse(input);
  const authority = publicConfig.deployment_control;
  if (parsed.issuer !== authority.issuer || parsed.subject !== authority.subject || parsed.authority_key_id !== authority.key_id) throw new Error("D02 local receipt does not match the deployment-control public configuration.");
  const unsigned = { ...parsed } as Record<string, unknown>;
  delete unsigned.signature;
  const publicKey = createPublicKey({ key: Buffer.from(authority.public_key_spki_base64, "base64"), format: "der", type: "spki" });
  if (!ed25519Verify(null, Buffer.from(canonicalRequestHash(unsigned), "hex"), publicKey, Buffer.from(parsed.signature, "base64url"))) throw new Error("D02 local controller receipt signature verification failed.");
}

export async function signD02WorkerTerminationReceipt(
  raw: Omit<D02WorkerTerminationControllerReceipt, "signature">,
  publicConfig: PublicAuthorityConfig,
  privateKeyPath: string,
): Promise<D02WorkerTerminationControllerReceipt> {
  const authority = publicConfig.deployment_control;
  if (raw.authority !== "deployment_control" || raw.issuer !== authority.issuer || raw.subject !== authority.subject || raw.authority_key_id !== authority.key_id) throw new Error("D02 worker-termination receipt authority binding is invalid.");
  const privateKey = await readPrivateKey(privateKeyPath);
  assertPrivateKeyMatchesAuthority(privateKey, authority);
  const signature = ed25519Sign(null, Buffer.from(canonicalRequestHash(raw), "hex"), privateKey).toString("base64url");
  const signed = D02WorkerTerminationControllerReceiptSchema.parse({ ...raw, signature });
  verifyD02WorkerTerminationReceipt(signed, publicConfig);
  return signed;
}

export function verifyD02WorkerTerminationReceipt(input: D02WorkerTerminationControllerReceipt, publicConfig: PublicAuthorityConfig): void {
  const parsed = D02WorkerTerminationControllerReceiptSchema.parse(input);
  const authority = publicConfig.deployment_control;
  if (parsed.issuer !== authority.issuer || parsed.subject !== authority.subject || parsed.authority_key_id !== authority.key_id) throw new Error("D02 worker-termination receipt does not match the deployment-control public configuration.");
  const unsigned = { ...parsed } as Record<string, unknown>;
  delete unsigned.signature;
  const publicKey = createPublicKey({ key: Buffer.from(authority.public_key_spki_base64, "base64"), format: "der", type: "spki" });
  if (!ed25519Verify(null, Buffer.from(canonicalRequestHash(unsigned), "hex"), publicKey, Buffer.from(parsed.signature, "base64url"))) throw new Error("D02 worker-termination controller receipt signature verification failed.");
}

export function newUnsignedClaim(input: {
  run: {
    run_id: string;
    test_run_id_sha256: string;
    cleanup_obligation_id_sha256: string;
    scenario_id: "V-A03" | "V-D02" | "V-P01";
    scenario_version: "vt00.scenarios.v1";
    environment: "production" | "staging";
    expected_deployment: { frontend: string; backend: string; voice: string };
  };
  authority: AuthorityName;
  publicConfig: PublicAuthorityConfig;
  evidence: UnsignedExternalAttestation["evidence"];
  now?: Date;
  ttlMs?: number;
}): UnsignedExternalAttestation {
  const now = input.now ?? new Date();
  const attestationId = randomUUID();
  const authority = input.publicConfig[input.authority];
  return parseUnsignedClaim({
    schema: "sophia_voice_lab_external_attestation_v1",
    attestation_id: attestationId,
    ...input.run,
    issuer: authority.issuer,
    audience: "sophia-voice-lab-attestation",
    authority_key_id: authority.key_id,
    jti: attestationId,
    nonce: randomBytes(32).toString("base64url"),
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + (input.ttlMs ?? 300_000)).toISOString(),
    signature_algorithm: "ed25519-sha256-canonical-request-v1",
    evidence: input.evidence,
  }, input.publicConfig, now);
}

async function readPrivateKey(target: string): Promise<KeyObject> {
  const bytes = await readSecureFile(target, 4096);
  try {
    const key = createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key;
  } catch {
    throw new Error("Private-key file is not an Ed25519 PKCS8 key.");
  } finally {
    bytes.fill(0);
  }
}

function assertPrivateKeyMatchesAuthority(privateKey: KeyObject, authority: PublicAuthorityConfig[AuthorityName]): void {
  const actual = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const expected = Buffer.from(authority.public_key_spki_base64, "base64");
  if (actual.length !== expected.length || !Buffer.from(actual).equals(expected)) throw new Error("Private key does not match the selected source authority.");
}

export function contentHash(value: unknown): string {
  return canonicalRequestHash(value);
}
