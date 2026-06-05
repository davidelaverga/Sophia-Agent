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

export type CoreviewWorkspaceActorType = "user" | "sophia" | "system" | "future_collaborator"

export interface CoreviewWorkspaceActor {
  type: CoreviewWorkspaceActorType
  id?: string | null
  displayName?: string | null
}

export interface CoreviewWorkspaceEvent {
  id: string
  type: CoreviewWorkspaceEventType
  actor: CoreviewWorkspaceActor
  occurredAt: string
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

export function isCoreviewWorkspaceEventType(value: unknown): value is CoreviewWorkspaceEventType {
  return typeof value === "string" && COREVIEW_WORKSPACE_EVENT_TYPE_SET.has(value)
}
