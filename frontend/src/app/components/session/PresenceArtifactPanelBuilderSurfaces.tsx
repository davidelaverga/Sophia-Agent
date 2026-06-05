import type { Dispatch, SetStateAction } from "react"

import type { useArtifactCoReview } from "../../hooks/useArtifactCoReview"
import type { ArtifactViewState } from "../../lib/artifact-renderers"
import type {
  CoreviewAddAnnotationAdapterInput,
  CoreviewAddAnnotationAdapterResult,
} from "../../lib/coreview-actions"
import type { CoreviewAnnotationStoreTelemetry } from "../../lib/coreview-annotation-store"
import { cn } from "../../lib/utils"
import type { ArtifactAnnotation, ArtifactToolMode } from "../../types/artifact-annotations"
import type { BuilderArtifactLibraryItemV1, BuilderArtifactV1 } from "../../types/builder-artifact"
import type { RitualArtifacts } from "../../types/session"

import type { ArtifactVisualCaptureStatus } from "./ArtifactCanvasViewport"
import { ArtifactStage, type ArtifactReviewVoiceCommandTarget } from "./ArtifactStage"
import { CoreviewRealArtifactCanvas } from "./CoreviewRealArtifactCanvas"
import {
  COREVIEW_COMPANION_ARTIFACT_ID,
  PresenceArtifactSecondarySurfaces,
} from "./PresenceArtifactSecondarySurfaces"
import { VoiceArtifactStage } from "./VoiceArtifactStage"

export { COREVIEW_COMPANION_ARTIFACT_ID }
export type { ArtifactReviewVoiceCommandTarget }

type ArtifactCoReviewModel = ReturnType<typeof useArtifactCoReview>

type BuilderArtifactStageSurfaceProps = {
  builderArtifactLibrary: BuilderArtifactLibraryItemV1[]
  stageBuilderArtifact: BuilderArtifactV1 | null
  hasBuilder: boolean
  builderArtifactId: string | null
  stageUsesMarkdownPreview: boolean
  stageUsesPdfPreview: boolean
  isTextModeBuilderStage: boolean
  isVoiceMode: boolean
  revealStep: number
  sessionId?: string | null
  normalSessionId?: string | null
  voiceAgentSessionId?: string | null
  threadId?: string | null
  artifactStableIdentity: string | null
  coreviewAnnotationList: ArtifactAnnotation[]
  coreviewAnnotationTelemetry: CoreviewAnnotationStoreTelemetry
  addCoreviewAnnotation: (input: CoreviewAddAnnotationAdapterInput) => CoreviewAddAnnotationAdapterResult
  updateCoreviewAnnotation: (annotationId: string, patch: { text?: string | null }) => boolean
  deleteCoreviewAnnotation: (annotationId: string) => boolean
  builderArtifactCoReview: ArtifactCoReviewModel
  builderExactTextAvailable: boolean
  visualReviewPreparing: boolean
  visualReviewRequiresVoice: boolean
  pendingBuilderArtifactReview: boolean
  builderVisualCaptureStatus: ArtifactVisualCaptureStatus
  voiceCommandViewPending: boolean
  builderReviewStale: boolean
  voiceCommandStatusText: string | null
  voiceCommandStatusTone?: "neutral" | "pending" | "success" | "warn"
  setBuilderVisualCaptureStatus: Dispatch<SetStateAction<ArtifactVisualCaptureStatus>>
  handleReportedBuilderArtifactViewStateChange: (state: ArtifactViewState) => void
  handleBuilderVoiceCommandTargetChange: (target: ArtifactReviewVoiceCommandTarget | null) => void
  handleWorkspaceToolModeChange: (mode: ArtifactToolMode) => void
  handleWorkspaceExportRequested: (input: { exportKind: "original" | "annotated"; annotationCount: number }) => void
  onStartVoiceBuilderArtifactReview?: () => void
  onBuilderArtifactRootChange: (node: HTMLDivElement | null) => void
}

export function PresenceArtifactPanelBuilderSurfaces({
  artifacts,
  builderArtifactLibrary,
  stageBuilderArtifact,
  hasBuilder,
  builderArtifactId,
  stageUsesMarkdownPreview,
  stageUsesPdfPreview,
  isTextModeBuilderStage,
  isVoiceMode,
  revealStep,
  sessionId,
  normalSessionId,
  voiceAgentSessionId,
  threadId,
  artifactStableIdentity,
  coreviewAnnotationList,
  coreviewAnnotationTelemetry,
  addCoreviewAnnotation,
  updateCoreviewAnnotation,
  deleteCoreviewAnnotation,
  builderArtifactCoReview,
  builderExactTextAvailable,
  visualReviewPreparing,
  visualReviewRequiresVoice,
  pendingBuilderArtifactReview,
  builderVisualCaptureStatus,
  voiceCommandViewPending,
  builderReviewStale,
  voiceCommandStatusText,
  voiceCommandStatusTone,
  setBuilderVisualCaptureStatus,
  handleReportedBuilderArtifactViewStateChange,
  handleBuilderVoiceCommandTargetChange,
  handleWorkspaceToolModeChange,
  handleWorkspaceExportRequested,
  onStartVoiceBuilderArtifactReview,
  showSecondaryArtifactSurfaces,
  showDomArtifactCoReview,
  isActive,
  bloomColor,
  reflectionTapped,
  domArtifactCoReview,
  onSelectedBuilderArtifactPathChange,
  onHandleReflectionTap,
  onReflectionTap,
  onMemoryApprove,
  onMemoryReject,
  onBuilderArtifactRootChange,
  onDomArtifactRootChange,
}: {
  artifacts: RitualArtifacts | null | undefined
  builderArtifactLibrary: BuilderArtifactLibraryItemV1[]
  stageBuilderArtifact: BuilderArtifactV1 | null
  hasBuilder: boolean
  builderArtifactId: string | null
  stageUsesMarkdownPreview: boolean
  stageUsesPdfPreview: boolean
  isTextModeBuilderStage: boolean
  isVoiceMode: boolean
  revealStep: number
  sessionId?: string | null
  normalSessionId?: string | null
  voiceAgentSessionId?: string | null
  threadId?: string | null
  artifactStableIdentity: string | null
  coreviewAnnotationList: ArtifactAnnotation[]
  coreviewAnnotationTelemetry: CoreviewAnnotationStoreTelemetry
  addCoreviewAnnotation: (input: CoreviewAddAnnotationAdapterInput) => CoreviewAddAnnotationAdapterResult
  updateCoreviewAnnotation: (annotationId: string, patch: { text?: string | null }) => boolean
  deleteCoreviewAnnotation: (annotationId: string) => boolean
  builderArtifactCoReview: ArtifactCoReviewModel
  builderExactTextAvailable: boolean
  visualReviewPreparing: boolean
  visualReviewRequiresVoice: boolean
  pendingBuilderArtifactReview: boolean
  builderVisualCaptureStatus: ArtifactVisualCaptureStatus
  voiceCommandViewPending: boolean
  builderReviewStale: boolean
  voiceCommandStatusText: string | null
  voiceCommandStatusTone?: "neutral" | "pending" | "success" | "warn"
  setBuilderVisualCaptureStatus: Dispatch<SetStateAction<ArtifactVisualCaptureStatus>>
  handleReportedBuilderArtifactViewStateChange: (state: ArtifactViewState) => void
  handleBuilderVoiceCommandTargetChange: (target: ArtifactReviewVoiceCommandTarget | null) => void
  handleWorkspaceToolModeChange: (mode: ArtifactToolMode) => void
  handleWorkspaceExportRequested: (input: { exportKind: "original" | "annotated"; annotationCount: number }) => void
  onStartVoiceBuilderArtifactReview?: () => void
  showSecondaryArtifactSurfaces: boolean
  showDomArtifactCoReview: boolean
  isActive: boolean
  bloomColor: string
  reflectionTapped: boolean
  domArtifactCoReview: ArtifactCoReviewModel
  onSelectedBuilderArtifactPathChange?: (path: string | null) => void
  onHandleReflectionTap: () => void
  onReflectionTap?: (reflection: { prompt: string; why?: string }) => void
  onMemoryApprove?: (index: number) => void
  onMemoryReject?: (index: number) => void
  onBuilderArtifactRootChange: (node: HTMLDivElement | null) => void
  onDomArtifactRootChange: (node: HTMLDivElement | null) => void
}) {
  return (
    <>
      <BuilderArtifactStageSurface
        builderArtifactLibrary={builderArtifactLibrary}
        stageBuilderArtifact={stageBuilderArtifact}
        hasBuilder={hasBuilder}
        builderArtifactId={builderArtifactId}
        stageUsesMarkdownPreview={stageUsesMarkdownPreview}
        stageUsesPdfPreview={stageUsesPdfPreview}
        isTextModeBuilderStage={isTextModeBuilderStage}
        isVoiceMode={isVoiceMode}
        revealStep={revealStep}
        sessionId={sessionId}
        normalSessionId={normalSessionId}
        voiceAgentSessionId={voiceAgentSessionId}
        threadId={threadId}
        artifactStableIdentity={artifactStableIdentity}
        coreviewAnnotationList={coreviewAnnotationList}
        coreviewAnnotationTelemetry={coreviewAnnotationTelemetry}
        addCoreviewAnnotation={addCoreviewAnnotation}
        updateCoreviewAnnotation={updateCoreviewAnnotation}
        deleteCoreviewAnnotation={deleteCoreviewAnnotation}
        builderArtifactCoReview={builderArtifactCoReview}
        builderExactTextAvailable={builderExactTextAvailable}
        visualReviewPreparing={visualReviewPreparing}
        visualReviewRequiresVoice={visualReviewRequiresVoice}
        pendingBuilderArtifactReview={pendingBuilderArtifactReview}
        builderVisualCaptureStatus={builderVisualCaptureStatus}
        voiceCommandViewPending={voiceCommandViewPending}
        builderReviewStale={builderReviewStale}
        voiceCommandStatusText={voiceCommandStatusText}
        voiceCommandStatusTone={voiceCommandStatusTone}
        setBuilderVisualCaptureStatus={setBuilderVisualCaptureStatus}
        handleReportedBuilderArtifactViewStateChange={handleReportedBuilderArtifactViewStateChange}
        handleBuilderVoiceCommandTargetChange={handleBuilderVoiceCommandTargetChange}
        handleWorkspaceToolModeChange={handleWorkspaceToolModeChange}
        handleWorkspaceExportRequested={handleWorkspaceExportRequested}
        onStartVoiceBuilderArtifactReview={onStartVoiceBuilderArtifactReview}
        onBuilderArtifactRootChange={onBuilderArtifactRootChange}
      />

      <PresenceArtifactSecondarySurfaces
        artifacts={artifacts}
        builderArtifactLibrary={builderArtifactLibrary}
        stageBuilderArtifact={stageBuilderArtifact}
        showSecondaryArtifactSurfaces={showSecondaryArtifactSurfaces}
        showDomArtifactCoReview={showDomArtifactCoReview}
        threadId={threadId}
        sessionId={sessionId}
        normalSessionId={normalSessionId}
        revealStep={revealStep}
        isActive={isActive}
        bloomColor={bloomColor}
        reflectionTapped={reflectionTapped}
        domArtifactCoReview={domArtifactCoReview}
        onSelectedBuilderArtifactPathChange={onSelectedBuilderArtifactPathChange}
        onHandleReflectionTap={onHandleReflectionTap}
        onReflectionTap={onReflectionTap}
        onMemoryApprove={onMemoryApprove}
        onMemoryReject={onMemoryReject}
        onDomArtifactRootChange={onDomArtifactRootChange}
      />
    </>
  )
}

function BuilderArtifactStageSurface({
  builderArtifactLibrary,
  stageBuilderArtifact,
  hasBuilder,
  builderArtifactId,
  stageUsesMarkdownPreview,
  stageUsesPdfPreview,
  isTextModeBuilderStage,
  isVoiceMode,
  revealStep,
  sessionId,
  normalSessionId,
  voiceAgentSessionId,
  threadId,
  artifactStableIdentity,
  coreviewAnnotationList,
  coreviewAnnotationTelemetry,
  addCoreviewAnnotation,
  updateCoreviewAnnotation,
  deleteCoreviewAnnotation,
  builderArtifactCoReview,
  builderExactTextAvailable,
  visualReviewPreparing,
  visualReviewRequiresVoice,
  pendingBuilderArtifactReview,
  builderVisualCaptureStatus,
  voiceCommandViewPending,
  builderReviewStale,
  voiceCommandStatusText,
  voiceCommandStatusTone,
  setBuilderVisualCaptureStatus,
  handleReportedBuilderArtifactViewStateChange,
  handleBuilderVoiceCommandTargetChange,
  handleWorkspaceToolModeChange,
  handleWorkspaceExportRequested,
  onStartVoiceBuilderArtifactReview,
  onBuilderArtifactRootChange,
}: BuilderArtifactStageSurfaceProps) {
  if (!hasBuilder || !stageBuilderArtifact) {
    return null
  }

  const visualCaptureStatus = stageUsesMarkdownPreview || stageUsesPdfPreview
    ? builderVisualCaptureStatus
    : null

  return (
    <div
      ref={onBuilderArtifactRootChange}
      className={cn(
        "relative transition-all duration-[1400ms] ease-out",
        isTextModeBuilderStage && "flex min-h-0 flex-1 flex-col",
        isVoiceMode && "flex h-full min-h-0 w-full flex-col overflow-hidden",
        revealStep >= 1 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2",
      )}
    >
      {builderArtifactId && !stageUsesMarkdownPreview && !stageUsesPdfPreview && (
        <CoreviewRealArtifactCanvas
          artifactId={builderArtifactId}
          builderArtifact={stageBuilderArtifact}
          sessionId={sessionId}
          normalSessionId={normalSessionId}
          voiceAgentSessionId={voiceAgentSessionId}
          threadId={threadId}
          artifactStableIdentity={artifactStableIdentity}
        />
      )}

      <div
        className={cn(
          isTextModeBuilderStage && "flex min-h-0 flex-1 flex-col",
          isVoiceMode && "flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden",
        )}
        onClick={(event) => event.stopPropagation()}
      >
        {isVoiceMode ? (
          <VoiceArtifactStage
            builderArtifact={stageBuilderArtifact}
            builderArtifactLibrary={builderArtifactLibrary}
            threadId={threadId}
            artifactId={builderArtifactId}
            sessionId={sessionId}
            normalSessionId={normalSessionId}
            voiceAgentSessionId={voiceAgentSessionId}
            artifactStableIdentity={artifactStableIdentity}
            annotations={coreviewAnnotationList}
            annotationStoreTelemetry={coreviewAnnotationTelemetry}
            onAddAnnotation={addCoreviewAnnotation}
            onUpdateAnnotation={updateCoreviewAnnotation}
            onDeleteAnnotation={deleteCoreviewAnnotation}
            reviewState={builderArtifactCoReview.state}
            transportStatus={builderArtifactCoReview.transportStatus}
            exactTextAvailable={builderExactTextAvailable}
            canStartReview={builderArtifactCoReview.canStart}
            reviewEnabled={builderArtifactCoReview.enabled}
            visualReviewPreparing={visualReviewPreparing}
            pendingStartVoiceReview={pendingBuilderArtifactReview}
            visualCaptureStatus={visualCaptureStatus}
            reviewViewPending={voiceCommandViewPending}
            reviewStale={builderReviewStale}
            canRefreshReview={builderArtifactCoReview.canRefresh}
            voiceCommandStatusText={voiceCommandStatusText}
            voiceCommandStatusTone={voiceCommandStatusTone}
            onVisualCaptureStatusChange={setBuilderVisualCaptureStatus}
            onArtifactViewStateChange={handleReportedBuilderArtifactViewStateChange}
            onVoiceCommandTargetChange={handleBuilderVoiceCommandTargetChange}
            onWorkspaceToolModeChange={handleWorkspaceToolModeChange}
            onWorkspaceExportRequested={handleWorkspaceExportRequested}
            onStartReview={() => { void builderArtifactCoReview.startReview() }}
            onStopReview={() => { void builderArtifactCoReview.stopReview() }}
            onRefreshReview={() => { void builderArtifactCoReview.refreshReview() }}
          />
        ) : (
          <ArtifactStage
            builderArtifact={stageBuilderArtifact}
            builderArtifactLibrary={builderArtifactLibrary}
            threadId={threadId}
            artifactId={builderArtifactId}
            sessionId={sessionId}
            normalSessionId={normalSessionId}
            voiceAgentSessionId={voiceAgentSessionId}
            artifactStableIdentity={artifactStableIdentity}
            annotations={coreviewAnnotationList}
            annotationStoreTelemetry={coreviewAnnotationTelemetry}
            onAddAnnotation={addCoreviewAnnotation}
            onUpdateAnnotation={updateCoreviewAnnotation}
            onDeleteAnnotation={deleteCoreviewAnnotation}
            reviewState={builderArtifactCoReview.state}
            transportStatus={builderArtifactCoReview.transportStatus}
            exactTextAvailable={builderExactTextAvailable}
            canStartReview={builderArtifactCoReview.canStart}
            reviewEnabled={builderArtifactCoReview.enabled}
            visualReviewRequiresVoice={visualReviewRequiresVoice}
            pendingStartVoiceReview={pendingBuilderArtifactReview}
            visualCaptureStatus={visualCaptureStatus}
            reviewViewPending={voiceCommandViewPending}
            reviewStale={builderReviewStale}
            canRefreshReview={builderArtifactCoReview.canRefresh}
            voiceCommandStatusText={voiceCommandStatusText}
            voiceCommandStatusTone={voiceCommandStatusTone}
            onVisualCaptureStatusChange={setBuilderVisualCaptureStatus}
            onArtifactViewStateChange={handleReportedBuilderArtifactViewStateChange}
            onVoiceCommandTargetChange={handleBuilderVoiceCommandTargetChange}
            onWorkspaceToolModeChange={handleWorkspaceToolModeChange}
            onWorkspaceExportRequested={handleWorkspaceExportRequested}
            onStartVoiceReview={onStartVoiceBuilderArtifactReview}
            onStartReview={() => { void builderArtifactCoReview.startReview() }}
            onStopReview={() => { void builderArtifactCoReview.stopReview() }}
            onRefreshReview={() => { void builderArtifactCoReview.refreshReview() }}
            fillAvailable={isTextModeBuilderStage}
            className={cn(isTextModeBuilderStage && "min-h-0 flex-1")}
          />
        )}
      </div>
    </div>
  )
}
