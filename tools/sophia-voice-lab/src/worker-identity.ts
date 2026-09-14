import { randomUUID } from "node:crypto";
import { VoiceLabError, labError } from "./domain.js";

/** Render's instance inventory omits the replica-set segment present in
 * RENDER_INSTANCE_ID. Preserve the full ownership ID everywhere else. Unknown
 * shapes fail closed; this projection is not a browser-closure proof. */
export function renderInventoryInstanceId(workerId: string): string | null {
  const full = /^(srv-[0-9a-z]{20})-[a-f0-9]{8,10}-([a-z0-9]{5})$/.exec(workerId);
  if (full) return `${full[1]}-${full[2]}`;
  return /^srv-[0-9a-z]{20}-[a-z0-9]{5}$/.test(workerId) ? workerId : null;
}

/** Production ownership must join the existing Render controller's exact
 * instance inventory. A generated boot identifier is not a platform owner. */
export function resolveWorkerIdentity(nodeEnv: string, env: NodeJS.ProcessEnv): string {
  const instanceId = env.RENDER_INSTANCE_ID;
  if (instanceId !== undefined) {
    // Match the controller's inventory identity grammar without normalization.
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(instanceId)) {
      throw new VoiceLabError(labError("WORKER_INSTANCE_ID_INVALID", "Worker platform instance identity is malformed.", "internal"));
    }
    return instanceId;
  }
  if (nodeEnv !== "test" && nodeEnv !== "development") {
    throw new VoiceLabError(labError("WORKER_INSTANCE_ID_REQUIRED", "Production worker requires its platform instance identity before resource initialization.", "internal"));
  }
  return `worker-${randomUUID()}`;
}
