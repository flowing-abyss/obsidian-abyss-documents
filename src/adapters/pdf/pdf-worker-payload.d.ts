declare module 'pdfjs-dist/build/pdf.mjs' {
  export * from 'pdfjs-dist';
}

declare module 'pdfjs-dist/build/pdf.worker.mjs?gzip-base64' {
  const compressedWorkerBase64: string;

  export default compressedWorkerBase64;
}
