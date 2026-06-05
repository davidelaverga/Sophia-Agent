import { describe, expect, it } from "vitest"

import {
  buildCoreviewWorkspaceActor,
  COREVIEW_WORKSPACE_EVENT_TYPES,
  isCoreviewWorkspaceEventType,
} from "../../app/lib/coreview-workspace-events"

describe("Coreview workspace event contract", () => {
  it("declares the Phase 1 local event vocabulary", () => {
    expect(COREVIEW_WORKSPACE_EVENT_TYPES).toContain("artifact.opened")
    expect(COREVIEW_WORKSPACE_EVENT_TYPES).toContain("annotation.created")
    expect(COREVIEW_WORKSPACE_EVENT_TYPES).toContain("participant.left")
    expect(isCoreviewWorkspaceEventType("share.requested")).toBe(true)
    expect(isCoreviewWorkspaceEventType("backend.sync.started")).toBe(false)
  })

  it("builds user actors for manual annotation events without voice session ids", () => {
    const actor = buildCoreviewWorkspaceActor({
      kind: "user",
      userId: "user-1",
      voiceAgentSessionId: "voice-session-1",
    })

    expect(actor).toMatchObject({
      kind: "user",
      id: "user:user-1",
    })
    expect(actor.id).not.toContain("voice-session")
  })

  it("builds Sophia actors for Coreview tool annotation events", () => {
    const actor = buildCoreviewWorkspaceActor({
      kind: "sophia",
      userId: "user-1",
      threadId: "thread-1",
    })

    expect(actor).toMatchObject({
      kind: "sophia",
      id: "sophia:personal:user-1",
    })
  })

  it("builds room-scoped Sophia actors for future shared-room actions", () => {
    const actor = buildCoreviewWorkspaceActor({
      kind: "sophia",
      threadId: "thread-1",
      sophiaScope: "room",
    })

    expect(actor).toMatchObject({
      kind: "sophia",
      id: "sophia:room:thread-1",
    })
  })

  it("builds system actors for restore and migration events", () => {
    const actor = buildCoreviewWorkspaceActor({ kind: "system" })

    expect(actor).toMatchObject({
      kind: "system",
      id: "system",
    })
  })
})
