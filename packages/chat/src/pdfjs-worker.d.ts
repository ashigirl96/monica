// pdfjs-dist は worker の build に型を付けていない。pdf-worker.ts は globalThis.pdfjsWorker に置くだけで中身を使わない。
declare module 'pdfjs-dist/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown
}
