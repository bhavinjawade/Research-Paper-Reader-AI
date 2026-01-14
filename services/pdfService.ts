
import * as pdfjsLib from 'pdfjs-dist';

// Use a reliable CDN path for the PDF.js worker that matches the version in index.html.
// Version 5+ typically expects an ESM worker (.mjs).
const PDF_JS_VERSION = '5.4.530';
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDF_JS_VERSION}/build/pdf.worker.min.mjs`;

export const parsePdf = async (file: File, onProgress: (p: number) => void) => {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({
      data: arrayBuffer,
      useWorkerFetch: true,
      isEvalSupported: false,
    });

    const pdf = await loadingTask.promise;
    const numPages = pdf.numPages;
    const pages = [];

    for (let i = 1; i <= numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.5 });

      // Extract Text
      const textContent = await page.getTextContent();
      const text = textContent.items
        .map((item: any) => item.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Render to Canvas for Image extraction
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (context) {
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        const base64Image = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];

        pages.push({
          index: i,
          text,
          image: base64Image
        });
      }

      onProgress((i / numPages) * 100);
    }

    return pages;
  } catch (error) {
    console.error("PDF parsing error:", error);
    throw new Error("Failed to parse PDF. This can happen if the worker fails to load or the file is corrupted.");
  }
};
