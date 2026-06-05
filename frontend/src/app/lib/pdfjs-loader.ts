export interface PdfViewport {
  width: number
  height: number
}

export interface PdfRenderTask {
  promise: Promise<unknown>
  cancel: () => void
}

export interface PdfPageProxy {
  getViewport: (options: { scale: number }) => PdfViewport
  render: (params: {
    canvas: HTMLCanvasElement
    viewport: PdfViewport
    transform?: number[]
  }) => PdfRenderTask
  getTextContent?: () => Promise<unknown>
}

export interface PdfDocumentProxy {
  numPages: number
  fingerprints?: Array<string | null | undefined>
  getPage: (pageNumber: number) => Promise<PdfPageProxy>
}

export interface PdfLoadingTask {
  promise: Promise<PdfDocumentProxy>
  destroy?: () => Promise<void> | void
}

export interface PdfJsModule {
  getDocument: (params: { data: Uint8Array }) => PdfLoadingTask
}

export async function loadPdfJs(): Promise<PdfJsModule> {
  return import("pdfjs-dist/webpack.mjs") as Promise<PdfJsModule>
}
