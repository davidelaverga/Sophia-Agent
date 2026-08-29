import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testConfig } from "./helpers.js";

describe("deployment identity configuration", () => {
  it("hard-stops drift with only safe commit fingerprints", () => {
    const serviceVersion = "b".repeat(40);
    const repositoryCandidate = "a".repeat(40);

    expect(() => testConfig({
      RENDER_GIT_COMMIT: serviceVersion,
      SOPHIA_VOICE_LAB_REPOSITORY_CANDIDATE_SHA: repositoryCandidate,
    })).toThrowError(expect.objectContaining({
      detail: expect.objectContaining({
        code: "CONFIG_INVALID",
        details: {
          service_version_source: "RENDER_GIT_COMMIT",
          service_version_sha256: createHash("sha256").update(serviceVersion).digest("hex"),
          repository_candidate_sha256: createHash("sha256").update(repositoryCandidate).digest("hex"),
          service_version_length: 40,
          repository_candidate_length: 40,
          raw_commit_identities_excluded: true,
        },
      }),
    }));
  });
});
