import type { BuilderArtifactV1 } from "../types/builder-artifact"

import { isHtmlArtifactFile, isMarkdownArtifactFile } from "./builder-artifacts"

export type ArtifactRendererKind =
  | "markdown"
  | "html"
  | "pdf"
  | "image"
  | "metadata"
  | "download_only"
  | "unsupported"

export type ArtifactFitMode = "page" | "width" | "custom"

export interface ArtifactRendererFileInput {
  path?: string | null
  name?: string | null
  mimeType?: string | null
}

export interface ArtifactViewState {
  artifactId: string | null
  filePath: string | null
  rendererKind: ArtifactRendererKind
  pageIndex: number
  pageCount: number
  zoom: number
  fitMode: ArtifactFitMode
}

const PDF_EXTENSIONS = [".pdf"]
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]
const DOWNLOAD_ONLY_EXTENSIONS = [
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".zip",
]

export function detectArtifactRendererKind(
  file: ArtifactRendererFileInput | null | undefined,
  artifact?: Pick<BuilderArtifactV1, "artifactType"> | null,
): ArtifactRendererKind {
  if (!file?.path && !file?.name) {
    return "unsupported"
  }

  if (isMarkdownArtifactFile(file)) {
    return "markdown"
  }

  if (isHtmlArtifactFile(file)) {
    return "html"
  }

  if (isPdfArtifactFile(file, artifact)) {
    return "pdf"
  }

  if (isImageArtifactFile(file)) {
    return "image"
  }

  if (hasExtension(file, DOWNLOAD_ONLY_EXTENSIONS)) {
    return "download_only"
  }

  return "metadata"
}

export function isPdfArtifactFile(
  file: ArtifactRendererFileInput | null | undefined,
  artifact?: Pick<BuilderArtifactV1, "artifactType"> | null,
): boolean {
  if (!file && !artifact) {
    return false
  }

  const mimeType = normalizeMimeType(file?.mimeType)
  if (mimeType === "application/pdf" || mimeType === "application/x-pdf") {
    return true
  }

  const artifactType = artifact?.artifactType?.toLowerCase().trim() ?? ""
  if (artifactType === "pdf" || artifactType.includes("portable document")) {
    return true
  }

  return hasExtension(file, PDF_EXTENSIONS)
}

export function artifactRendererSupportsPagination(rendererKind: ArtifactRendererKind): boolean {
  return rendererKind === "pdf"
}

export function artifactRendererSupportsZoom(rendererKind: ArtifactRendererKind): boolean {
  return rendererKind === "pdf"
}

export function createDefaultArtifactViewState({
  artifactId = null,
  filePath = null,
  rendererKind = "unsupported",
}: Partial<Pick<ArtifactViewState, "artifactId" | "filePath" | "rendererKind">> = {}): ArtifactViewState {
  return {
    artifactId,
    filePath,
    rendererKind,
    pageIndex: 0,
    pageCount: 1,
    zoom: 1,
    fitMode: rendererKind === "pdf" ? "page" : "custom",
  }
}

export function buildArtifactViewSignature(state: ArtifactViewState | null | undefined): string | null {
  if (!state) {
    return null
  }

  return [
    `artifact:${state.artifactId ?? "none"}`,
    `path:${state.filePath ?? "none"}`,
    `renderer:${state.rendererKind}`,
    `page:${Math.max(0, state.pageIndex)}`,
    `zoom:${formatSignatureNumber(state.zoom)}`,
    `fit:${state.fitMode}`,
  ].join("|")
}

export function clampArtifactZoom(value: number): number {
  if (!Number.isFinite(value)) {
    return 1
  }
  return Math.min(3, Math.max(0.35, Number(value.toFixed(2))))
}

export function safeArtifactViewTelemetry(
  state: ArtifactViewState | null | undefined,
  lastFrameViewSignature: string | null,
  staleReason: string | null,
): Record<string, string | number | null> {
  return {
    artifactRendererKind: state?.rendererKind ?? null,
    artifactPageIndex: state ? Math.max(0, state.pageIndex) : null,
    artifactPageCount: state ? Math.max(1, state.pageCount) : null,
    artifactZoom: state ? clampArtifactZoom(state.zoom) : null,
    artifactFitMode: state?.fitMode ?? null,
    artifactViewSignature: buildArtifactViewSignature(state),
    artifactLastFrameViewSignature: lastFrameViewSignature,
    artifactReviewStaleReason: staleReason,
  }
}

function isImageArtifactFile(file: ArtifactRendererFileInput | null | undefined): boolean {
  const mimeType = normalizeMimeType(file?.mimeType)
  return mimeType.startsWith("image/") || hasExtension(file, IMAGE_EXTENSIONS)
}

function hasExtension(
  file: ArtifactRendererFileInput | null | undefined,
  extensions: string[],
): boolean {
  const values = [file?.name, file?.path]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase().split(/[?#]/u)[0] ?? "")

  return values.some((value) => extensions.some((extension) => value.endsWith(extension)))
}

function normalizeMimeType(value: string | null | undefined): string {
  return value?.toLowerCase().split(";")[0]?.trim() ?? ""
}

function formatSignatureNumber(value: number): string {
  return clampArtifactZoom(value).toFixed(2)
}
