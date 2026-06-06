import { afterEach, describe, expect, it } from "vitest"

import {
  clearCoreviewArtifactTextRegistryForTests,
  readCoreviewArtifactTextSideband,
  registerCoreviewArtifactText,
  registerCoreviewArtifactTextStatus,
} from "../../app/lib/coreview-artifact-text"

describe("Coreview artifact text registry", () => {
  afterEach(() => {
    clearCoreviewArtifactTextRegistryForTests()
  })

  it("allows a new voice session to read visible artifact text when the thread matches", () => {
    registerCoreviewArtifactText({
      artifactId: "artifact-1",
      source: "pdf_text_extraction",
      text: "North equals 42",
      sessionIds: ["old-voice-session"],
      threadId: "thread-1",
      artifactStableIdentity: "user:unknown|thread:thread-1|path:mnt/user-data/outputs/report.pdf|renderer:pdf",
    })

    const response = readCoreviewArtifactTextSideband({
      artifactId: "artifact-1",
      sessionId: "new-voice-session",
      threadId: "thread-1",
    })

    expect(response).toMatchObject({
      ok: true,
      source: "pdf_text_extraction",
      artifact_id: "artifact-1",
    })
    expect(response.ok ? response.text : "").toContain("North equals 42")
  })

  it("returns rebind-required instead of forbidden for old voice-only registrations", () => {
    registerCoreviewArtifactText({
      artifactId: "artifact-1",
      source: "pdf_text_extraction",
      text: "Budget delta is 17.4 percent",
      sessionIds: ["old-voice-session"],
    })

    const response = readCoreviewArtifactTextSideband({
      artifactId: "artifact-1",
      sessionId: "new-voice-session",
    })

    expect(response).toMatchObject({
      ok: false,
      status: "artifact_rebind_required",
      recovery_action: expect.stringContaining("reconnect voice"),
    })
  })

  it("keeps true thread mismatches forbidden with a recovery action", () => {
    registerCoreviewArtifactText({
      artifactId: "artifact-1",
      source: "pdf_text_extraction",
      text: "Other thread text",
      sessionIds: ["old-voice-session"],
      threadId: "other-thread",
    })

    const response = readCoreviewArtifactTextSideband({
      artifactId: "artifact-1",
      sessionId: "new-voice-session",
      threadId: "thread-1",
    })

    expect(response).toMatchObject({
      ok: false,
      status: "forbidden",
      safe_reason: expect.stringContaining("artifact_not_available_in_current_session"),
      recovery_action: expect.stringContaining("current session thread"),
    })
  })

  it("returns pending and failed PDF extraction statuses quickly", () => {
    registerCoreviewArtifactTextStatus({
      artifactId: "artifact-1",
      source: "pdf_text_extraction",
      status: "loading",
      threadId: "thread-1",
    })
    expect(readCoreviewArtifactTextSideband({
      artifactId: "artifact-1",
      sessionId: "voice-session",
      threadId: "thread-1",
    })).toMatchObject({
      ok: false,
      status: "extraction_pending",
    })

    clearCoreviewArtifactTextRegistryForTests()
    registerCoreviewArtifactTextStatus({
      artifactId: "artifact-1",
      source: "pdf_text_extraction",
      status: "failed",
      safeReason: "pdf_text_extraction_failed",
      threadId: "thread-1",
    })
    expect(readCoreviewArtifactTextSideband({
      artifactId: "artifact-1",
      sessionId: "voice-session",
      threadId: "thread-1",
    })).toMatchObject({
      ok: false,
      status: "extraction_failed",
      safe_reason: "pdf_text_extraction_failed",
    })
  })
})
