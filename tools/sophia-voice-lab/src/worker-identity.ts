import { randomUUID } from "node:crypto";
import { VoiceLabError, labError } from "./domain.js";

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
