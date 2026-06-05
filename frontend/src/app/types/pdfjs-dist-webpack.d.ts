declare module "pdfjs-dist/webpack.mjs" {
  export function getDocument(params: { data: Uint8Array }): {
    promise: Promise<unknown>
    destroy?: () => Promise<void> | void
  }
}
