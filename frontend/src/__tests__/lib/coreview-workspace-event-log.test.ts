import { beforeEach, describe, expect, it } from "vitest"

import {
  appendWorkspaceEvent,
  clearWorkspaceEventsForTestOnly,
  getCoreviewWorkspaceEventLogTelemetry,
  getLatestWorkspaceEvent,
  getWorkspaceEventCounts,
  getWorkspaceEvents,
  hashCoreviewWorkspaceKey,
} from "../../app/lib/coreview-workspace-event-log"
import { buildCoreviewWorkspaceActor } from "../../app/lib/coreview-workspace-events"
import { buildCoreviewWorkspaceShareState } from "../../app/lib/coreview-workspace-share"

const workspaceKey = "user:user-1|thread:thread-1"
const otherWorkspaceKey = "user:user-2|thread:thread-1"
const artifactKey = "user:user-1|thread:thread-1|path:mnt/user-data/outputs/report.pdf|renderer:pdf"
const userActor = buildCoreviewWorkspaceActor({ kind: "user", userId: "user-1" })
const sophiaActor = buildCoreviewWorkspaceActor({ kind: "sophia", userId: "user-1", threadId: "thread-1" })

beforeEach(() => {
  window.localStorage.clear()
  clearWorkspaceEventsForTestOnly()
})

describe("Coreview workspace event log", () => {
  it("appends and reads workspace events", () => {
    const event = appendWorkspaceEvent({
      type: "annotation.created",
      workspaceKey,
      artifactKey,
      actor: userActor,
      payload: {
        annotationId: "annotation-1",
        annotationKind: "highlight",
        pageIndex: 0,
      },
    })

    expect(event).toMatchObject({
      type: "annotation.created",
      workspaceKey,
      artifactKey,
      actor: userActor,
      version: 1,
    })
    expect(getWorkspaceEvents(workspaceKey)).toHaveLength(1)
    expect(getLatestWorkspaceEvent(workspaceKey, artifactKey)?.type).toBe("annotation.created")
  })

  it("restores events from localStorage", () => {
    appendWorkspaceEvent({
      type: "view.changed",
      workspaceKey,
      artifactKey,
      actor: sophiaActor,
      payload: { pageIndex: 1, zoom: 1.2 },
    })

    clearWorkspaceEventsForTestOnly(workspaceKey)
    const storageKeyHash = hashCoreviewWorkspaceKey(workspaceKey)
    expect(storageKeyHash).toBeTruthy()

    window.localStorage.setItem(
      `sophia:coreview-workspace-events:v1:${storageKeyHash}`,
      JSON.stringify({
        version: 1,
        workspaceKey,
        events: [{
          id: "event-1",
          type: "view.changed",
          workspaceKey,
          artifactKey,
          actor: sophiaActor,
          createdAt: "2026-06-05T12:00:00.000Z",
          version: 1,
          payload: { pageIndex: 1, rawFrameExcluded: true },
        }],
        updatedAt: "2026-06-05T12:00:00.000Z",
      }),
    )

    expect(getWorkspaceEvents(workspaceKey)).toHaveLength(1)
    expect(getWorkspaceEventCounts(workspaceKey)).toMatchObject({
      eventCount: 1,
      viewChangedEventCount: 1,
      lastEventType: "view.changed",
      lastActorKind: "sophia",
    })
  })

  it("isolates different workspace keys", () => {
    appendWorkspaceEvent({
      type: "artifact.opened",
      workspaceKey,
      artifactKey,
      actor: userActor,
      payload: { artifactId: "artifact-1" },
    })
    appendWorkspaceEvent({
      type: "artifact.opened",
      workspaceKey: otherWorkspaceKey,
      artifactKey,
      actor: buildCoreviewWorkspaceActor({ kind: "user", userId: "user-2" }),
      payload: { artifactId: "artifact-1" },
    })

    expect(getWorkspaceEvents(workspaceKey)).toHaveLength(1)
    expect(getWorkspaceEvents(otherWorkspaceKey)).toHaveLength(1)
    expect(getWorkspaceEvents("user:unknown|thread:thread-1")).toHaveLength(0)
  })

  it("fails safely when stored event log data is corrupt", () => {
    const storageKeyHash = hashCoreviewWorkspaceKey(workspaceKey)
    window.localStorage.setItem(`sophia:coreview-workspace-events:v1:${storageKeyHash}`, "not-json")

    expect(getWorkspaceEvents(workspaceKey)).toEqual([])
    const telemetry = getCoreviewWorkspaceEventLogTelemetry(
      workspaceKey,
      artifactKey,
      buildCoreviewWorkspaceShareState({ workspaceKey, artifactKey }),
    )
    expect(telemetry.workspaceEventLogPersistResult).toBe("corrupt")
    expect(telemetry.workspaceEventLogRestoreCount).toBe(0)
  })

  it("does not persist raw frame data or raw comment text in event payloads", () => {
    appendWorkspaceEvent({
      type: "annotation.created",
      workspaceKey,
      artifactKey,
      actor: sophiaActor,
      payload: {
        annotationId: "annotation-1",
        commentText: "change the font",
        annotation: {
          id: "annotation-1",
          text: "change the font",
        },
        frameData: "base64-frame",
        rawFrameData: "raw-frame",
        artifactText: "raw artifact body",
      },
    })

    const serialized = JSON.stringify(getWorkspaceEvents(workspaceKey))
    expect(serialized).not.toContain("change the font")
    expect(serialized).not.toContain("base64-frame")
    expect(serialized).not.toContain("raw artifact body")
    expect(serialized).toContain("rawCommentTextExcluded")
    expect(serialized).toContain("rawFrameExcluded")
  })

  it("summarizes telemetry without exposing event payload contents", () => {
    appendWorkspaceEvent({
      type: "annotation.created",
      workspaceKey,
      artifactKey,
      actor: userActor,
      payload: { annotationId: "annotation-1" },
    })
    appendWorkspaceEvent({
      type: "view.changed",
      workspaceKey,
      artifactKey,
      actor: sophiaActor,
      payload: { pageIndex: 1 },
    })
    const telemetry = getCoreviewWorkspaceEventLogTelemetry(
      workspaceKey,
      artifactKey,
      buildCoreviewWorkspaceShareState({ workspaceKey, artifactKey }),
    )

    expect(telemetry).toMatchObject({
      coreviewWorkspaceEventLogActive: true,
      coreviewWorkspaceContractVersion: 1,
      coreviewWorkspaceEventCount: 2,
      coreviewWorkspaceLastEventType: "view.changed",
      coreviewWorkspaceActorKind: "sophia",
      coreviewWorkspaceHasShareReadyMetadata: true,
      coreviewShareStatus: "unavailable",
      workspaceEventLogPersistResult: "saved",
      annotationEventsCreatedCount: 1,
      viewChangedEventCount: 1,
      rawCommentTextExcluded: true,
      rawArtifactTextExcluded: true,
      rawFrameExcluded: true,
    })
    expect(JSON.stringify(telemetry)).not.toContain("annotation-1")
  })
})
