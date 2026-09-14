import { createHmac, timingSafeEqual } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canonicalRequestHash } from "../../src/security.js";
import { ServiceOwnerFenceResumeSchema, type ServiceOwnerFenceCheckpoint } from "./service-owner-fence-controller.js";
import { readSecureJson, writeNewSecureJson } from "./secure-files.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const entrySchema = z.object({
  schema: z.literal("sophia.voice-lab.service-owner-fence-journal.v1"),
  index: z.number().int().min(0).max(63), inputSha256: hash, previousSha256: hash.nullable(),
  phase: z.enum(["intent", "prepared", "consumed", "accepted", "receipt"]), payload: z.unknown(),
  sha256: hash, hmacSha256: hash,
}).strict();
type Entry = z.infer<typeof entrySchema>;

/** Exclusive atomic files fence competing offline collectors. A failed write
 * poisons this writer; only a new authenticated resume can inspect its result.
 * The server's consumed dispatch remains the sole permission to restart. */
export async function openServiceOwnerFenceJournal(input: {
  directory: string; inputSha256: string; macKey: Buffer; resume: boolean;
}) {
  hash.parse(input.inputSha256);
  if (input.macKey.byteLength < 32) throw new Error("Service fence journal key is too short.");
  if (!path.isAbsolute(input.directory) || path.normalize(input.directory) !== input.directory) throw new Error("Service fence journal path must be absolute and normalized.");
  const stat = await lstat(input.directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Service fence journal requires a private real directory.");
  const names = (await readdir(input.directory)).filter(name => !name.startsWith(".")).sort();
  if (names.length > 64 || names.some((name, index) => name !== filename(index))) throw new Error("Service fence journal is gapped or contains unexpected entries.");
  if (input.resume ? names.length === 0 : names.length !== 0) throw new Error("Service fence journal requires explicit resume or an empty new directory.");
  const entries: Entry[] = [];
  let state: Record<string, unknown> = {};
  const mac = (core: unknown) => createHmac("sha256", input.macKey).update("sophia-voice-lab:service-owner-fence-journal:v1\0").update(canonicalRequestHash(core)).digest("hex");
  const advance = (phase: Entry["phase"], payload: unknown) => {
    if (phase === "intent") {
      if (entries.length || canonicalRequestHash(payload) !== canonicalRequestHash({ inputSha256: input.inputSha256 })) throw new Error("Invalid service fence journal intent.");
      return state;
    }
    if (!entries.length || state.receipt || (phase === "prepared" && state.consumed)
      || (phase === "consumed" && (!state.prepared || state.consumed))
      || (phase === "accepted" && (!state.consumed || state.accepted))
      || (phase === "receipt" && !state.accepted)) throw new Error("Invalid service fence journal phase order.");
    return ServiceOwnerFenceResumeSchema.parse({ ...state, [phase]: payload });
  };
  for (const name of names) {
    const entry = entrySchema.parse(await readSecureJson(path.join(input.directory, name)));
    const { sha256: digest, hmacSha256, ...core } = entry;
    if (entry.index !== entries.length || entry.inputSha256 !== input.inputSha256
      || entry.previousSha256 !== (entries.at(-1)?.sha256 ?? null) || digest !== canonicalRequestHash(core)
      || !timingSafeEqual(Buffer.from(hmacSha256, "hex"), Buffer.from(mac(core), "hex"))) throw new Error("Service fence journal authentication or scope mismatch.");
    state = advance(entry.phase, entry.payload); entries.push(entry);
  }
  let poisoned = false;
  const append = async (phase: Entry["phase"], payload: unknown) => {
    if (poisoned || entries.length >= 64) throw new Error("Service fence journal requires a fresh resume.");
    poisoned = true;
    const next = advance(phase, payload);
    const core = { schema: "sophia.voice-lab.service-owner-fence-journal.v1" as const, index: entries.length,
      inputSha256: input.inputSha256, previousSha256: entries.at(-1)?.sha256 ?? null, phase, payload };
    const entry = entrySchema.parse({ ...core, sha256: canonicalRequestHash(core), hmacSha256: mac(core) });
    await writeNewSecureJson(path.join(input.directory, filename(entries.length)), entry);
    entries.push(entry); state = next; poisoned = false;
  };
  if (!input.resume) await append("intent", { inputSha256: input.inputSha256 });
  return {
    resume: Object.keys(state).length ? ServiceOwnerFenceResumeSchema.parse(state) : undefined,
    checkpoint: async (entry: ServiceOwnerFenceCheckpoint) => append(entry.phase, entry.value),
  };
}
function filename(index: number) { return `${String(index).padStart(3, "0")}-service-owner-fence.json`; }
