import { createHmac } from "node:crypto";

/** Existing v1 bytes: changing this framing would orphan retained identities. */
export function retentionHmac(key: string, domain: "lookup" | "recovery", value: string): string {
  return createHmac("sha256", key).update(`sophia-voice-lab-retention-v1\n${domain}\n${value}`).digest("hex");
}
