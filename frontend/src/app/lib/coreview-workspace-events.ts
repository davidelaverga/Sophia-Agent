export type CoreviewWorkspaceEventType =
  | "artifact.opened"
  | "artifact.closed"
  | "view.changed"
  | "annotation.created"
  | "annotation.updated"
  | "annotation.deleted"
  | "tool.changed"
  | "export.requested"
  | "share.requested"
  | "participant.joined"
  | "participant.left"

export type CoreviewWorkspaceActorKind = "user" | "sophia" | "system" | "collaborator_future"
export type CoreviewWorkspaceActorType = CoreviewWorkspaceActorKind

export interface CoreviewWorkspaceActor {
  kind: CoreviewWorkspaceActorKind
  id: string
  displayName?: string | null
}

export interface CoreviewWorkspaceEvent {
  id: string
  type: CoreviewWorkspaceEventType
  workspaceKey: string
  artifactKey?: string | null
  actor: CoreviewWorkspaceActor
  createdAt: string
  version: 1
  payload: Record<string, unknown>
  artifactId?: string | null
  artifactStableIdentity?: string | null
  threadId?: string | null
  builderTaskId?: string | null
}

export const COREVIEW_WORKSPACE_EVENT_TYPES: readonly CoreviewWorkspaceEventType[] = [
  "artifact.opened",
  "artifact.closed",
  "view.changed",
  "annotation.created",
  "annotation.updated",
  "annotation.deleted",
  "tool.changed",
  "export.requested",
  "share.requested",
  "participant.joined",
  "participant.left",
]

const COREVIEW_WORKSPACE_EVENT_TYPE_SET = new Set<string>(COREVIEW_WORKSPACE_EVENT_TYPES)

export type CoreviewWorkspaceActorInput = {
  kind: CoreviewWorkspaceActorKind
  userId?: string | null
  threadId?: string | null
  collaboratorId?: string | null
  displayName?: string | null
  sophiaScope?: "personal" | "room"
  voiceAgentSessionId?: string | null
}

export function isCoreviewWorkspaceEventType(value: unknown): value is CoreviewWorkspaceEventType {
  return typeof value === "string" && COREVIEW_WORKSPACE_EVENT_TYPE_SET.has(value)
}

export function buildCoreviewWorkspaceActor(input: CoreviewWorkspaceActorInput): CoreviewWorkspaceActor {
  const userId = normalizeActorToken(input.userId) ?? "unknown"
  const threadId = normalizeActorToken(input.threadId) ?? "unknown"
  const collaboratorId = normalizeActorToken(input.collaboratorId) ?? "unknown"

  switch (input.kind) {
    case "sophia": {
      const scope = input.sophiaScope === "room" ? "room" : "personal"
      return {
        kind: "sophia",
        id: scope === "room" ? `sophia:room:${threadId}` : `sophia:personal:${userId}`,
        displayName: input.displayName ?? null,
      }
    }
    case "system":
      return {
        kind: "system",
        id: "system",
        displayName: input.displayName ?? null,
      }
    case "collaborator_future":
      return {
        kind: "collaborator_future",
        id: `collaborator_future:${collaboratorId}`,
        displayName: input.displayName ?? null,
      }
    case "user":
    default:
      return {
        kind: "user",
        id: `user:${userId}`,
        displayName: input.displayName ?? null,
      }
  }
}

function normalizeActorToken(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null
  }
  const normalized = value.trim()
  return normalized || null
}
