export type ArtifactToolMode = "select" | "pan" | "highlight" | "comment"
export type ArtifactAnnotationColor = "yellow" | "purple" | "blue" | "pink"
export type ArtifactAnnotationSource = "sophia" | "user"

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

export type ArtifactAnnotation =
  | {
      id: string
      kind: "highlight"
      pageIndex: number
      rect: NormalizedArtifactRect
      color?: ArtifactAnnotationColor
      source?: ArtifactAnnotationSource
      point?: never
      text?: never
      createdAt: number
    }
  | {
      id: string
      kind: "comment"
      pageIndex: number
      point: NormalizedArtifactPoint
      source?: ArtifactAnnotationSource
      rect?: never
      text: string
      createdAt: number
    }
