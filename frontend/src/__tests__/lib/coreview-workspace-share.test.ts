import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  appendWorkspaceEvent,
  clearWorkspaceEventsForTestOnly,
  getWorkspaceEvents,
} from "../../app/lib/coreview-workspace-event-log"
import { buildCoreviewWorkspaceActor } from "../../app/lib/coreview-workspace-events"
import { buildCoreviewWorkspaceShareState } from "../../app/lib/coreview-workspace-share"

beforeEach(() => {
  clearWorkspaceEventsForTestOnly()
  window.localStorage.clear()
})

describe("Coreview workspace share metadata", () => {
  it("truthfully reports sharing as unavailable by default", () => {
    const state = buildCoreviewWorkspaceShareState({
      workspaceKey: "user:user-1|thread:thread-1",
      artifactKey: "artifact-key",
    })

    expect(state).toEqual({
      status: "unavailable",
      workspaceKey: "user:user-1|thread:thread-1",
      artifactKey: "artifact-key",
      permissionsModel: "not_implemented",
      participants: [],
      userFacingTruth: "Sharing is not available yet.",
    })
  })

  it("can represent a local placeholder request without implying real sharing", () => {
    const state = buildCoreviewWorkspaceShareState({
      workspaceKey: "user:user-1|thread:thread-1",
      artifactKey: "artifact-key",
      status: "requested_local",
    })

    expect(state.status).toBe("requested_local")
    expect(state.permissionsModel).toBe("not_implemented")
    expect(state.participants).toEqual([])
    expect(state.userFacingTruth).toBe("Sharing is not available yet.")
  })

  it("can record a local share.requested placeholder event without enabling sharing", () => {
    const workspaceKey = "user:user-1|thread:thread-1"
    const artifactKey = "artifact-key"
    const state = buildCoreviewWorkspaceShareState({
      workspaceKey,
      artifactKey,
      status: "requested_local",
    })

    const event = appendWorkspaceEvent({
      type: "share.requested",
      workspaceKey,
      artifactKey,
      actor: buildCoreviewWorkspaceActor({ kind: "user", userId: "user-1" }),
      payload: {
        shareStatus: state.status,
        permissionsModel: state.permissionsModel,
      },
    })

    expect(event.type).toBe("share.requested")
    expect(event.actor.kind).toBe("user")
    expect(getWorkspaceEvents(workspaceKey, artifactKey)).toHaveLength(1)
    expect(state.userFacingTruth).toBe("Sharing is not available yet.")
  })

  it("does not make backend or network calls", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")

    buildCoreviewWorkspaceShareState({
      workspaceKey: "user:user-1|thread:thread-1",
      artifactKey: "artifact-key",
      status: "requested_local",
    })

    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
