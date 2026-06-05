export type CoreviewLayoutIndexStatus = "unavailable" | "pending" | "ready" | "failed"

export type CoreviewLayoutIndexSource =
  | "pdf_text_layout"
  | "markdown_text"
  | "html_dom"
  | "docx_future"
  | "pptx_future"
  | "ocr_future"

export interface CoreviewLayoutRegion {
  pageIndex?: number
  x: number
  y: number
  width: number
  height: number
}

export interface CoreviewLayoutPoint {
  pageIndex?: number
  x: number
  y: number
}

export interface CoreviewLayoutSelection {
  pageIndex?: number
  startTextOffset?: number
  endTextOffset?: number
  regions?: CoreviewLayoutRegion[]
}

export type CoreviewLayoutAnchor =
  | { type: "current_title" }
  | { type: "text_quote"; text: string; occurrence?: number }
  | { type: "region"; region: CoreviewLayoutRegion }
  | { type: "point"; point: CoreviewLayoutPoint }
  | { type: "selection"; selection: CoreviewLayoutSelection }

export interface CoreviewLayoutIndexState {
  status: CoreviewLayoutIndexStatus
  source: CoreviewLayoutIndexSource
  supportsBoundingBoxes: boolean
  pageCount?: number
}

export function createUnavailableCoreviewLayoutIndex(
  source: CoreviewLayoutIndexSource,
): CoreviewLayoutIndexState {
  return {
    status: "unavailable",
    source,
    supportsBoundingBoxes: false,
  }
}
