import type { PDFDocumentProxy } from 'pdfjs-dist/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import { isPdfAbortFailure, mapPdfOpenFailure, mapPdfOutline } from './pdf-mappers.js';

function pdfDocument(): PDFDocumentProxy {
  return {
    getDestination: vi.fn(async (name: string) => {
      if (name === 'chapter-one') return [{ num: 7, gen: 0 }, { name: 'Fit' }];
      return null;
    }),
    getPageIndex: vi.fn(async (reference: { num: number }) => {
      if (reference.num === 99) throw new Error('missing page');
      return reference.num - 5;
    }),
  } as unknown as PDFDocumentProxy;
}

describe('mapPdfOutline', () => {
  it('recognizes legacy numeric abort codes with a non-string name', () => {
    expect(isPdfAbortFailure({ name: 42, code: 20 })).toBe(true);
  });

  it('uses the password-required message when a password code is not numeric', () => {
    const failure = mapPdfOpenFailure(
      'Guide.pdf',
      { name: 'PasswordException', code: 'unknown' },
      new AbortController().signal,
    );

    expect(failure.message).toBe('This PDF requires a password. Try again and enter the password.');
  });

  it('maps named and explicit destinations recursively in source order', async () => {
    const pdf = pdfDocument();

    const outline = await mapPdfOutline(pdf, [
      {
        title: 'Chapter 1',
        dest: 'chapter-one',
        items: [
          {
            title: 'Details',
            dest: [{ num: 8, gen: 0 }, { name: 'XYZ' }, 12, 34, null],
            items: [],
          },
        ],
      },
      { title: 'Appendix', dest: [4, { name: 'Fit' }], items: [] },
    ]);

    expect(outline).toEqual([
      {
        id: 'outline-0',
        label: 'Chapter 1',
        target: { pageIndex: 2 },
        children: [
          {
            id: 'outline-0-0',
            label: 'Details',
            target: { pageIndex: 3, x: 12, y: 34 },
            children: [],
          },
        ],
      },
      { id: 'outline-1', label: 'Appendix', target: { pageIndex: 4 }, children: [] },
    ]);
  });

  it('keeps unresolved destinations as null without rejecting the outline', async () => {
    const pdf = pdfDocument();

    const outline = await mapPdfOutline(pdf, [
      { title: 'Unknown name', dest: 'missing', items: [] },
      { title: 'Unknown page', dest: [{ num: 99, gen: 0 }], items: [] },
      { title: 'External link', dest: null, items: [] },
    ]);

    expect(outline.map((item) => item.target)).toEqual([null, null, null]);
  });

  it('omits invalid optional XYZ coordinates', async () => {
    const outline = await mapPdfOutline(pdfDocument(), [
      { title: 'Position', dest: [2, { name: 'XYZ' }, null, Number.POSITIVE_INFINITY], items: [] },
    ]);

    expect(outline[0]?.target).toEqual({ pageIndex: 2 });
  });
});
