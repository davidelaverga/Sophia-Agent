export type ArtifactToolMode = "select" | "pan" | "highlight" | "comment"

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
      point?: never
      text?: never
      createdAt: number
    }
  | {
      id: string
      kind: "comment"
      pageIndex: number
      point: NormalizedArtifactPoint
      rect?: never
      text: string
      createdAt: number
    }
