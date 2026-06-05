import {
  getBuilderArtifactFiles,
  normalizeBuilderArtifactPath,
} from "../../lib/builder-artifacts"
import type { BuilderArtifactLibraryItemV1, BuilderArtifactV1 } from "../../types/builder-artifact"

export function normalizeStageBuilderArtifactPath(path: string | null | undefined): string | null {
  return normalizeBuilderArtifactPath(path)
}

export function buildCoreviewRealArtifactId(builderArtifact: BuilderArtifactV1): string {
  const normalizedPath = normalizeBuilderArtifactPath(builderArtifact.artifactPath)
  const source = normalizedPath || builderArtifact.artifactTitle || builderArtifact.artifactType || "builder-artifact"
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)

  return `coreview-real-artifact-${slug || "builder-artifact"}`
}

export function buildStageBuilderArtifact({
  builderArtifact,
  selectedBuilderArtifactPath,
  selectedLibraryItem,
  latestLibraryItem,
}: {
  builderArtifact?: BuilderArtifactV1 | null
  selectedBuilderArtifactPath?: string | null
  selectedLibraryItem?: BuilderArtifactLibraryItemV1 | null
  latestLibraryItem?: BuilderArtifactLibraryItemV1 | null
}): BuilderArtifactV1 | null {
  const normalizedSelectedPath = normalizeBuilderArtifactPath(selectedBuilderArtifactPath)

  if (normalizedSelectedPath) {
    const selectedExistingArtifact = builderArtifact
      ? buildSelectedArtifactFromExisting(builderArtifact, normalizedSelectedPath)
      : null

    if (selectedExistingArtifact) {
      return selectedExistingArtifact
    }

    if (selectedLibraryItem) {
      return buildLibraryArtifact(selectedLibraryItem)
    }

    return buildSelectedPathArtifact(normalizedSelectedPath)
  }

  if (latestLibraryItem) {
    const latestExistingArtifact = builderArtifact
      ? buildSelectedArtifactFromExisting(builderArtifact, latestLibraryItem.path)
      : null

    return latestExistingArtifact ?? buildLibraryArtifact(latestLibraryItem)
  }

  if (builderArtifact) {
    return builderArtifact
  }

  return null
}

export function getStagePrimaryFileWithMime(
  stageBuilderArtifact: BuilderArtifactV1 | null,
  builderArtifactLibrary: BuilderArtifactLibraryItemV1[],
) {
  const files = getBuilderArtifactFiles(stageBuilderArtifact)
  const file = files.find((candidate) => candidate.isPrimary) ?? files[0] ?? null

  if (!file) {
    return null
  }

  const libraryItem = builderArtifactLibrary.find((item) => item.path === file.path)
  return {
    ...file,
    ...(libraryItem?.mimeType ? { mimeType: libraryItem.mimeType } : {}),
    ...(typeof libraryItem?.sizeBytes === "number" ? { sizeBytes: libraryItem.sizeBytes } : {}),
  }
}

export function exactTextRehydrateResult({
  isPdf,
  exactTextAvailable,
  pdfStatus,
}: {
  isPdf: boolean
  exactTextAvailable: boolean
  pdfStatus?: string | null
}): string {
  if (!isPdf) {
    return exactTextAvailable ? "not_pdf_exact_text_available" : "not_pdf"
  }
  if (exactTextAvailable || pdfStatus === "success") {
    return "success"
  }
  if (pdfStatus === "loading") {
    return "pending"
  }
  if (pdfStatus === "failed") {
    return "failed"
  }
  return "unavailable"
}

function getPathFilename(path: string | undefined): string {
  return path?.split("/").filter(Boolean).pop() || "Builder deliverable"
}

function inferArtifactTypeFromMetadata(
  name: string | undefined,
  mimeTypeValue?: string,
): BuilderArtifactV1["artifactType"] {
  const mimeType = mimeTypeValue?.toLowerCase().split(";")[0]?.trim() ?? ""
  const extension = name?.split(".").pop()?.toLowerCase() ?? ""

  if (mimeType.includes("presentation") || extension === "ppt" || extension === "pptx") {
    return "presentation"
  }
  if (mimeType.includes("html") || extension === "html" || extension === "htm") {
    return "webpage"
  }
  if (
    mimeType.includes("json")
    || mimeType.includes("csv")
    || ["csv", "json", "xlsx", "xls"].includes(extension)
  ) {
    return "data_analysis"
  }
  if (mimeType.includes("image") || extension === "svg") {
    return "visual_report"
  }

  return "document"
}

function inferArtifactType(item: BuilderArtifactLibraryItemV1): BuilderArtifactV1["artifactType"] {
  return inferArtifactTypeFromMetadata(item.name, item.mimeType)
}

function buildLibraryArtifact(item: BuilderArtifactLibraryItemV1): BuilderArtifactV1 {
  return {
    artifactPath: item.path,
    artifactTitle: item.name || getPathFilename(item.path),
    artifactType: inferArtifactType(item),
    decisionsMade: [],
    companionSummary: "Ready to preview in the artifact canvas.",
    userNextAction: "Review it with Sophia when you are ready.",
  }
}

function buildSelectedPathArtifact(path: string): BuilderArtifactV1 | null {
  const normalizedPath = normalizeBuilderArtifactPath(path)
  if (!normalizedPath) {
    return null
  }

  const name = getPathFilename(normalizedPath)
  return {
    artifactPath: normalizedPath,
    artifactTitle: name,
    artifactType: inferArtifactTypeFromMetadata(name),
    decisionsMade: [],
    supportingFiles: [],
    userNextAction: "Open or download the artifact if the in-canvas preview is unavailable.",
  }
}

function buildSelectedArtifactFromExisting(builderArtifact: BuilderArtifactV1, path: string): BuilderArtifactV1 | null {
  const files = getBuilderArtifactFiles(builderArtifact)
  const selectedFile = files.find((file) => file.path === path)

  if (!selectedFile) {
    return null
  }

  return {
    ...builderArtifact,
    artifactPath: selectedFile.path,
    artifactTitle: selectedFile.isPrimary ? builderArtifact.artifactTitle : selectedFile.label,
    supportingFiles: files
      .filter((file) => file.path !== selectedFile.path)
      .map((file) => file.path),
  }
}
