export type CoreviewWorkspaceShareStatus = "unavailable" | "ready_future" | "requested_local"

export type CoreviewWorkspaceShareState = {
  status: CoreviewWorkspaceShareStatus
  workspaceKey: string
  artifactKey?: string | null
  permissionsModel: "not_implemented"
  participants: []
  userFacingTruth: "Sharing is not available yet."
}

export const COREVIEW_WORKSPACE_SHARE_UNAVAILABLE_TRUTH = "Sharing is not available yet."

export function buildCoreviewWorkspaceShareState(input: {
  workspaceKey: string
  artifactKey?: string | null
  status?: CoreviewWorkspaceShareStatus
}): CoreviewWorkspaceShareState {
  return {
    status: input.status ?? "unavailable",
    workspaceKey: input.workspaceKey,
    artifactKey: input.artifactKey ?? null,
    permissionsModel: "not_implemented",
    participants: [],
    userFacingTruth: COREVIEW_WORKSPACE_SHARE_UNAVAILABLE_TRUTH,
  }
}
