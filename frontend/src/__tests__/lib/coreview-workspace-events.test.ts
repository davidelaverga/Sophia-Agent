import { describe, expect, it } from "vitest"

import {
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
})
