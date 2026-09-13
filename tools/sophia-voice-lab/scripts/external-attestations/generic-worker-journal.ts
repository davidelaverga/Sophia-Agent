import { createHmac, timingSafeEqual } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canonicalRequestHash } from "../../src/security.js";
import { GenericWorkerControllerResumeSchema, type GenericWorkerControllerCheckpoint } from "./generic-worker-controller.js";
import { readSecureJson, writeNewSecureJson } from "./secure-files.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const entrySchema = z.object({
  schema: z.literal("sophia.voice-lab.generic-worker-journal.v1"),
  index: z.number().int().min(0).max(63), inputSha256: hash, previousSha256: hash.nullable(),
  phase: z.enum(["intent", "prepared", "consumed", "accepted", "receipt"]), payload: z.unknown(),
  sha256: hash, hmacSha256: hash,
}).strict();
type Entry = z.infer<typeof entrySchema>;

/** Atomic exclusive publication is the concurrency fence: a losing writer must
 * stop, never reload/retry an append within the same controller invocation.
 * The server's consumed journal remains the authoritative one-shot permit. */
export async function openGenericWorkerJournal(input: {
  directory: string; inputSha256: string; macKey: Buffer; resume: boolean;
}) {
  hash.parse(input.inputSha256);
  if (!path.isAbsolute(input.directory) || path.normalize(input.directory) !== input.directory) throw new Error("Journal directory must be absolute and normalized.");
  const stat = await lstat(input.directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Journal requires a private real directory (0700 or stricter).");
  const names = (await readdir(input.directory)).filter(name => !name.startsWith(".")).sort();
  if (names.length > 64 || names.some((name, index) => name !== filename(index))) throw new Error("Generic journal is gapped or contains unexpected entries.");
  if (input.resume ? names.length === 0 : names.length !== 0) throw new Error("Generic journal requires explicit resume of an existing intent, or an empty new directory.");
  const entries: Entry[] = [];
  let state: Record<string, unknown> = {};
  const mac = (core: unknown) => createHmac("sha256", input.macKey).update("sophia-voice-lab:generic-worker-journal:v1\0").update(canonicalRequestHash(core)).digest("hex");
  const advance = (phase: Entry["phase"], payload: unknown) => {
    if (phase === "intent") {
      if (entries.length !== 0 || canonicalRequestHash(payload) !== canonicalRequestHash({ inputSha256: input.inputSha256 })) throw new Error("Invalid generic journal intent.");
      return state;
    }
    if (entries.length === 0 || state.receipt || (phase === "prepared" && state.consumed)
      || (phase === "consumed" && (!state.prepared || state.consumed))
      || (phase === "accepted" && (!state.consumed || state.accepted))
      || (phase === "receipt" && !state.accepted)) throw new Error("Invalid generic journal phase order.");
    // Repeated pre-consumption observations are immutable new entries, never
    // overwrites of the original prepared observation.
    return GenericWorkerControllerResumeSchema.parse({ ...state, [phase]: payload });
  };
  for (const name of names) {
    const entry = entrySchema.parse(await readSecureJson(path.join(input.directory, name)));
    const { sha256: digest, hmacSha256, ...core } = entry;
    if (entry.index !== entries.length || entry.inputSha256 !== input.inputSha256
      || entry.previousSha256 !== (entries.at(-1)?.sha256 ?? null)
      || digest !== canonicalRequestHash(core)
      || !timingSafeEqual(Buffer.from(hmacSha256, "hex"), Buffer.from(mac(core), "hex"))) throw new Error("Generic journal authentication or scope mismatch.");
    state = advance(entry.phase, entry.payload);
    entries.push(entry);
  }
  let poisoned = false;
  const append = async (phase: Entry["phase"], payload: unknown) => {
    if (poisoned || entries.length >= 64) throw new Error("Generic journal writer is exhausted or requires a fresh resume.");
    // Poison before any await, preventing concurrent callbacks from sharing an
    // index or continuing after an uncertain local publication.
    poisoned = true;
    const nextState = advance(phase, payload);
    const core = { schema: "sophia.voice-lab.generic-worker-journal.v1" as const,
      index: entries.length, inputSha256: input.inputSha256,
      previousSha256: entries.at(-1)?.sha256 ?? null, phase, payload };
    const entry = entrySchema.parse({ ...core, sha256: canonicalRequestHash(core), hmacSha256: mac(core) });
    await writeNewSecureJson(path.join(input.directory, filename(entries.length)), entry);
    entries.push(entry); state = nextState; poisoned = false;
  };
  if (!input.resume) await append("intent", { inputSha256: input.inputSha256 });
  return {
    resume: Object.keys(state).length ? GenericWorkerControllerResumeSchema.parse(state) : undefined,
    checkpoint: async (entry: GenericWorkerControllerCheckpoint) => append(entry.phase, entry.value),
  };
}

function filename(index: number) { return `${String(index).padStart(3, "0")}-generic-worker.json`; }
