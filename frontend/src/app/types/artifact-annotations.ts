export type ArtifactToolMode = "select" | "pan" | "highlight" | "comment" | "underline" | "arrow"
export type ArtifactAnnotationColor = "yellow" | "purple" | "blue" | "pink"
export type ArtifactAnnotationSource = "sophia" | "user"
export type ArtifactAnnotationKind = "highlight" | "comment" | "underline" | "arrow"

export interface NormalizedArtifactRect {
  x: number
  y: number
  width: number
  height: number
}

export interface NormalizedArtifactPoint {
  x: number
  y: number
}

export interface NormalizedArtifactLine {
  start: NormalizedArtifactPoint
  end: NormalizedArtifactPoint
}

interface ArtifactAnnotationBase {
  id: string
  kind: ArtifactAnnotationKind
  artifactStableIdentity?: string | null
  actorId?: string | null
  pageIndex: number
  color?: ArtifactAnnotationColor
  source?: ArtifactAnnotationSource
  createdAt: number
  updatedAt?: number
  version?: number
}

export type ArtifactAnnotation =
  | (ArtifactAnnotationBase & {
      kind: "highlight"
      rect: NormalizedArtifactRect
      point?: never
      line?: never
      text?: never
    })
  | (ArtifactAnnotationBase & {
      kind: "comment"
      point: NormalizedArtifactPoint
      rect?: never
      line?: never
      text: string
    })
  | (ArtifactAnnotationBase & {
      kind: "underline"
      rect: NormalizedArtifactRect
      point?: never
      line?: never
      text?: never
    })
  | (ArtifactAnnotationBase & {
      kind: "arrow"
      line: NormalizedArtifactLine
      rect?: never
      point?: never
      text?: never
    })
