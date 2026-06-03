import type * as PdfJs from "pdfjs-dist"

export type PdfJsModule = typeof PdfJs
export type PdfDocumentProxy = PdfJs.PDFDocumentProxy
export type PdfPageProxy = PdfJs.PDFPageProxy
export type PdfRenderTask = PdfJs.RenderTask

export async function loadPdfJs(): Promise<PdfJsModule> {
  return import("pdfjs-dist/webpack.mjs") as Promise<PdfJsModule>
}
