import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { deflateSync, inflateSync } from 'node:zlib';
import { OriginalRenderFidelityStatus, OriginalRenderSourceType } from '@prisma/client';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import type { AIReportInput, AIReportParagraph } from './report.contracts.js';
import {
  mapSegments,
  OriginalDocumentRenderer,
  type LayoutRectangle,
  type LayoutSegmentInput,
  type OriginalRenderInput,
} from './original-document-renderer.js';

const execFileAsync = promisify(execFile);
const DOCUMENT_ID = '66b2f3c5-14df-4156-a1df-152a7129f88e';
const VERSION_ID = '8edee971-57eb-478b-b811-5f83b8115ea3';
const RUN_ID = '31ec6f6f-4be4-49da-9bf5-ccf9fe77aab4';
const REPORT_ID = 'e564fa70-4188-4e8e-a4eb-98fda94f8865';

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function pngCrc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, value: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const checksumInput = Buffer.concat([name, value]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(pngCrc32(checksumInput));
  return Buffer.concat([length, name, value, checksum]);
}

function syntheticPng(): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const pixel = deflateSync(Buffer.from([0, 56, 126, 180, 255]));
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', pixel),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function tokenHash(value: string): string {
  return sha256(value.normalize('NFC').replace(/\u00ad/gu, '').toLowerCase());
}

function hashedPage(
  pageIndex: number,
  rows: Array<{ text: string; lineIndex: number }>,
  width = 400,
  height = 300,
) {
  return {
    pageIndex,
    width,
    height,
    words: rows.map((row, index) => ({
      tokenHash: tokenHash(row.text),
      xMin: 24 + index * 28,
      yMin: 36 + row.lineIndex * 22,
      xMax: 48 + index * 28,
      yMax: 48 + row.lineIndex * 22,
      lineIndex: row.lineIndex,
    })),
  };
}

function layoutSegment(
  paragraphIndex: number,
  text: string,
  overrides: Partial<LayoutSegmentInput> = {},
): LayoutSegmentInput {
  return {
    paragraphIndex,
    textHash: sha256(text),
    charStart: 0,
    charEnd: text.length,
    text,
    flagged: true,
    presentationExcluded: false,
    ...overrides,
  };
}

function reportParagraph(
  paragraphIndex: number,
  text: string,
  score: number | null,
  presentationExcluded = false,
): AIReportParagraph {
  return {
    paragraphIndex,
    textHash: sha256(text),
    charStart: 0,
    charEnd: text.length,
    segmentEvidence: {
      type: 'PARAGRAPH',
      paragraphId: paragraphIndex,
      start: 0,
      end: text.length,
      score,
      level: score === null ? null : 'HIGH',
    },
    score,
    signalLevel: score === null ? null : 'HIGH',
    classification: score === null ? 'INSUFFICIENT_TEXT' : 'HIGH_SIGNAL',
    reviewPresentation: {
      highlight: score !== null && !presentationExcluded,
      level: score === null ? null : 'HIGH',
      ...(presentationExcluded ? { excludedReason: 'REFERENCES_SECTION' } : {}),
    },
    presentationExcluded,
    ...(presentationExcluded ? { excludedReason: 'REFERENCES_SECTION' } : {}),
    textPreview: text,
    pageNumber: paragraphIndex + 1,
    words: text.split(/\s+/u).length,
    tokens: text.split(/\s+/u).length,
  };
}

function reportInput(paragraphs: AIReportParagraph[]): AIReportInput {
  const now = new Date('2026-10-18T16:00:00.000Z');
  return {
    reportId: REPORT_ID,
    generatedAt: now,
    turnitingVersion: 'synthetic-test',
    document: {
      id: DOCUMENT_ID,
      documentVersionId: VERSION_ID,
      filename: 'synthetic-original.pdf',
      mimeType: 'application/pdf',
      sourceChecksum: 'source-checksum-is-internal',
      storageKey: 'synthetic/source.pdf',
      createdAt: now,
      updatedAt: now,
    },
    extractedText: paragraphs.map((paragraph) => paragraph.textPreview).join('\n\n'),
    run: {
      id: RUN_ID,
      status: 'COMPLETED',
      analyzerMode: 'V3_ONLY',
      analyzerVersion: 'synthetic-analyzer-v1',
      thresholdProfile: 'BALANCED',
      threshold: 0.58,
      paragraphMode: 'STRICT_PARAGRAPH',
      documentAggregation: 'token_weighted_mean',
      documentScore: 0.42,
      signalLevel: 'MODERATE',
      scoredSegments: paragraphs.filter((paragraph) => paragraph.score !== null).length,
      insufficientSegments: paragraphs.filter((paragraph) => paragraph.score === null).length,
      inferenceMs: 1,
      cacheHit: false,
      metadata: {},
      createdAt: now,
      completedAt: now,
      modelNames: ['SYNTHETIC_MODEL'],
      modelVersions: ['synthetic-v1'],
    },
    paragraphs,
    history: [],
    limitations: ['Fixture sintético de prueba; no contiene información privada.'],
  };
}

function rendererHarness(source: Buffer) {
  const stored = new Map<string, Buffer>();
  const prisma = {
    originalRenderArtifact: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => ({ id: REPORT_ID, ...data })),
    },
    documentLayoutMap: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => ({ id: RUN_ID, ...data })),
    },
  };
  const documents = { read: vi.fn(async () => source) };
  const reports = {
    save: vi.fn(async (key: string, value: Buffer) => {
      stored.set(key, value);
    }),
    read: vi.fn(async (key: string) => {
      const value = stored.get(key);
      if (!value) throw new Error('Missing synthetic render');
      return value;
    }),
    exists: vi.fn(async (key: string) => stored.has(key)),
    delete: vi.fn(async (key: string) => stored.delete(key)),
  };
  const renderer = new OriginalDocumentRenderer(
    prisma as never,
    documents as never,
    reports as never,
  );
  return { renderer, prisma, documents, reports, stored };
}

function originalInput(
  source: Buffer,
  originalName: string,
  mimeType: string,
  texts: string[],
): OriginalRenderInput {
  return {
    documentId: DOCUMENT_ID,
    documentVersionId: VERSION_ID,
    analysisRunId: RUN_ID,
    storageKey: `synthetic/${originalName}`,
    sourceChecksum: sha256(source),
    originalName,
    mimeType,
    segments: texts.map((text, paragraphIndex) =>
      layoutSegment(paragraphIndex, text),
    ),
  };
}

function executableAvailable(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

const POPPLER_AVAILABLE = executableAvailable('pdftotext', ['-v']);
const PDF_RASTERIZER_AVAILABLE = executableAvailable('pdftoppm', ['-v']);
const PDFIMAGES_AVAILABLE = executableAvailable('pdfimages', ['-v']);
const LIBREOFFICE_AVAILABLE = executableAvailable('soffice', ['--version']);

interface RasterImage {
  width: number;
  height: number;
  channels: number;
  pixels: Buffer;
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodePng(buffer: Buffer): RasterImage {
  let width = 0;
  let height = 0;
  let channels = 0;
  const imageData: Buffer[] = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const colorType = data[9];
      channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
      if (data[8] !== 8 || channels === 0) {
        throw new Error('Synthetic PDF raster has an unsupported PNG format');
      }
    } else if (type === 'IDAT') {
      imageData.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const compressed = Buffer.concat(imageData);
  const inflated = inflateSync(compressed);
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset++]!;
    const rowOffset = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[sourceOffset++]!;
      const left = x >= channels ? pixels[rowOffset + x - channels]! : 0;
      const above = y > 0 ? pixels[rowOffset - stride + x]! : 0;
      const upperLeft = y > 0 && x >= channels
        ? pixels[rowOffset - stride + x - channels]!
        : 0;
      const value = filter === 0
        ? raw
        : filter === 1
          ? raw + left
          : filter === 2
            ? raw + above
            : filter === 3
              ? raw + Math.floor((left + above) / 2)
              : filter === 4
                ? raw + paeth(left, above, upperLeft)
                : Number.NaN;
      if (!Number.isFinite(value)) throw new Error('Unknown PNG filter');
      pixels[rowOffset + x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

function yellowPixelCount(image: RasterImage, rectangles: LayoutRectangle[]): number {
  let count = 0;
  for (const rectangle of rectangles) {
    const left = Math.max(0, Math.floor(rectangle.x));
    const top = Math.max(0, Math.floor(rectangle.y));
    const right = Math.min(image.width, Math.ceil(rectangle.x + rectangle.width));
    const bottom = Math.min(image.height, Math.ceil(rectangle.y + rectangle.height));
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const index = (y * image.width + x) * image.channels;
        if (
          image.pixels[index]! > 240 &&
          image.pixels[index + 1]! > 225 &&
          image.pixels[index + 2]! < 235
        ) {
          count += 1;
        }
      }
    }
  }
  return count;
}

describe('original document layout mapping', () => {
  it('maps repeated passages in order across pages and leaves ambiguous text unlocated', () => {
    const phrase = 'Alpha beta gamma delta';
    const pages = [
      hashedPage(0, [
        { text: 'Alpha', lineIndex: 0 },
        { text: 'beta', lineIndex: 0 },
      ]),
      hashedPage(1, [
        { text: 'gamma', lineIndex: 0 },
        { text: 'delta', lineIndex: 0 },
      ]),
      hashedPage(2, ['Alpha', 'beta', 'gamma', 'delta'].map((text) => ({ text, lineIndex: 0 }))),
      hashedPage(3, [
        { text: 'Reference', lineIndex: 0 },
        { text: 'source', lineIndex: 0 },
      ]),
    ];
    const result = mapSegments(pages as never, [
      layoutSegment(0, phrase),
      layoutSegment(1, phrase),
      layoutSegment(2, 'Alpha beta missing delta'),
      layoutSegment(3, 'Reference source', { presentationExcluded: true }),
    ]);

    expect(result.segments[0]).toMatchObject({
      mappingStatus: 'LOCATED',
      matchedTokenCount: 4,
      mappingCoverage: 1,
      mappingConfidence: 1,
      pageIndexes: [0, 1],
    });
    expect(result.segments[0]!.rectangles).toHaveLength(2);
    expect(result.segments[1]).toMatchObject({
      mappingStatus: 'LOCATED',
      pageIndexes: [2],
    });
    expect(result.segments[2]).toMatchObject({
      mappingStatus: 'FLAGGED_NOT_VISUALLY_LOCATED',
      rectangles: [],
      mappingConfidence: 0,
    });
    expect(result.segments[3]).toMatchObject({
      mappingStatus: 'PRESENTATION_EXCLUDED',
      pageIndexes: [3],
    });
  });

  it('matches Unicode normalization and a line-break hyphen without guessing nearby words', () => {
    const pages = [
      {
        pageIndex: 0,
        width: 400,
        height: 300,
        words: [
          {
            tokenHash: tokenHash('cafe\u0301'),
            xMin: 20,
            yMin: 30,
            xMax: 45,
            yMax: 42,
            lineIndex: 0,
          },
          {
            tokenHash: tokenHash('inter-'),
            joinNextHashes: [tokenHash('interwoven')],
            xMin: 50,
            yMin: 30,
            xMax: 75,
            yMax: 42,
            lineIndex: 0,
          },
          {
            tokenHash: tokenHash('woven'),
            xMin: 20,
            yMin: 50,
            xMax: 48,
            yMax: 62,
            lineIndex: 1,
          },
        ],
      },
    ];
    const result = mapSegments(pages as never, [
      layoutSegment(0, 'café interwoven'),
      layoutSegment(1, 'café interwovem'),
    ]);

    expect(result.segments[0]).toMatchObject({
      mappingStatus: 'LOCATED',
      matchedTokenCount: 2,
      mappingConfidence: 1,
    });
    expect(result.segments[0]!.rectangles).toHaveLength(2);
    expect(result.segments[1]).toMatchObject({
      mappingStatus: 'FLAGGED_NOT_VISUALLY_LOCATED',
      rectangles: [],
    });
  });
});

describe('OriginalDocumentRenderer PDF integration', () => {
  it.skipIf(!POPPLER_AVAILABLE || !PDF_RASTERIZER_AVAILABLE || !PDFIMAGES_AVAILABLE)(
    'passes a three-page source PDF through with images, a table, columns, and aligned highlights at 90, 180, and 270 degrees',
    async () => {
      const sourceDocument = await PDFDocument.create();
      const font = await sourceDocument.embedFont(StandardFonts.Helvetica);
      const normalText = 'Original paragraph stays vector and is visually highlighted.';
      const referenceText = 'Synthetic reference remains visible but is not highlighted.';
      const firstColumnText = 'Column one stays before column two.';
      const secondColumnText = 'Column two maps after the left column.';
      const rotatedText = 'Rotated paragraph maps correctly.';
      const firstPage = sourceDocument.addPage([400, 300]);
      firstPage.setRotation(degrees(90));
      firstPage.drawText(normalText, { x: 36, y: 218, size: 12, font });
      firstPage.drawText(referenceText, { x: 40, y: 164, size: 10, font });
      const logo = await sourceDocument.embedPng(syntheticPng());
      firstPage.drawImage(logo, { x: 332, y: 238, width: 24, height: 24 });
      firstPage.drawText('Synthetic PDF table', { x: 42, y: 95, size: 10, font });
      firstPage.drawLine({ start: { x: 40, y: 84 }, end: { x: 236, y: 84 }, thickness: 1 });
      firstPage.drawLine({ start: { x: 40, y: 58 }, end: { x: 236, y: 58 }, thickness: 1 });
      firstPage.drawLine({ start: { x: 40, y: 84 }, end: { x: 40, y: 58 }, thickness: 1 });
      firstPage.drawLine({ start: { x: 138, y: 84 }, end: { x: 138, y: 58 }, thickness: 1 });
      firstPage.drawLine({ start: { x: 236, y: 84 }, end: { x: 236, y: 58 }, thickness: 1 });
      firstPage.drawText('Cell one', { x: 48, y: 68, size: 9, font });
      firstPage.drawText('Cell two', { x: 147, y: 68, size: 9, font });

      const secondPage = sourceDocument.addPage([520, 380]);
      secondPage.setRotation(degrees(180));
      secondPage.drawText(firstColumnText, { x: 38, y: 312, size: 9, font });
      secondPage.drawText(secondColumnText, { x: 285, y: 312, size: 9, font });

      const thirdPage = sourceDocument.addPage([612, 432]);
      thirdPage.setRotation(degrees(270));
      thirdPage.drawText(rotatedText, { x: 64, y: 271, size: 12, font });
      const source = Buffer.from(await sourceDocument.save());
      const harness = rendererHarness(source);
      const segments = [
        normalText,
        referenceText,
        firstColumnText,
        secondColumnText,
        rotatedText,
      ];
      const request = originalInput(
        source,
        'synthetic-source.pdf',
        'application/pdf',
        segments,
      );
      request.segments[1]!.presentationExcluded = true;
      const ensured = await harness.renderer.ensure(request);

      expect(ensured.buffer).toEqual(source);
      expect(ensured.artifact.sourceType).toBe(OriginalRenderSourceType.PDF);
      expect(ensured.artifact.fidelityStatus).toBe(
        OriginalRenderFidelityStatus.EXACT_SOURCE_PDF,
      );
      expect(ensured.layoutMap.segments.map((segment) => segment.mappingStatus)).toEqual([
        'LOCATED',
        'PRESENTATION_EXCLUDED',
        'LOCATED',
        'LOCATED',
        'LOCATED',
      ]);
      expect(ensured.layoutMap.segments.map((segment) => segment.pageIndexes)).toEqual([
        [0],
        [0],
        [1],
        [1],
        [2],
      ]);

      const output = await harness.renderer.renderOriginalReview(
        reportInput(
          segments.map((text, index) =>
            reportParagraph(index, text, 0.58, index === 1),
          ),
        ),
        ensured.buffer,
        ensured.layoutMap,
      );
      const renderedDocument = await PDFDocument.load(output);
      expect(renderedDocument.getPageCount()).toBe(4);
      expect(renderedDocument.getPage(1).getRotation().angle).toBe(90);
      expect(renderedDocument.getPage(2).getRotation().angle).toBe(180);
      expect(renderedDocument.getPage(3).getRotation().angle).toBe(270);
      expect(
        [1, 2, 3].map((pageIndex) => {
          const { width, height } = renderedDocument.getPage(pageIndex).getMediaBox();
          return [width, height];
        }),
      ).toEqual([
        [400, 300],
        [520, 380],
        [612, 432],
      ]);

      const directory = await mkdtemp(path.join(tmpdir(), 'turniting-f0094-pdf-test-'));
      try {
        const outputPath = path.join(directory, 'review.pdf');
        await writeFile(outputPath, output, { mode: 0o600, flag: 'wx' });
        const textResult = await execFileAsync('pdftotext', ['-enc', 'UTF-8', outputPath, '-'], {
          encoding: 'utf8',
          timeout: 15_000,
        });
        expect(textResult.stdout).toContain('TURNITING');
        expect(textResult.stdout).toContain(normalText);
        expect(textResult.stdout).toContain(referenceText);
        expect(textResult.stdout).toContain('Synthetic PDF table');
        expect(textResult.stdout).toContain('Cell one');
        expect(textResult.stdout).toContain('Cell two');
        expect(textResult.stdout).toContain(firstColumnText);
        expect(textResult.stdout).toContain(secondColumnText);
        expect(textResult.stdout).toContain(rotatedText);

        const imageResult = await execFileAsync('pdfimages', ['-list', outputPath], {
          encoding: 'utf8',
          timeout: 15_000,
        });
        expect(imageResult.stdout).toMatch(/\n\s*\d+\s+\d+\s+image\s+/u);

        const rasterPages: RasterImage[] = [];
        for (const sourcePageIndex of [0, 1, 2]) {
          const pageNumber = sourcePageIndex + 2;
          const prefix = path.join(directory, `page-${pageNumber}`);
          await execFileAsync(
            'pdftoppm',
            ['-f', String(pageNumber), '-l', String(pageNumber), '-r', '72', '-singlefile', '-png', outputPath, prefix],
            { timeout: 20_000 },
          );
          const image = decodePng(await readFile(prefix + '.png'));
          rasterPages[sourcePageIndex] = image;
        }
        expect(
          yellowPixelCount(rasterPages[0]!, ensured.layoutMap.segments[0]!.rectangles),
          'highlight should align with vector text on source page 2',
        ).toBeGreaterThan(0);
        expect(
          yellowPixelCount(rasterPages[1]!, ensured.layoutMap.segments[2]!.rectangles),
          'highlight should align with the first column on source page 3',
        ).toBeGreaterThan(0);
        expect(
          yellowPixelCount(rasterPages[1]!, ensured.layoutMap.segments[3]!.rectangles),
          'highlight should align with the second column on source page 3',
        ).toBeGreaterThan(0);
        expect(
          yellowPixelCount(rasterPages[2]!, ensured.layoutMap.segments[4]!.rectangles),
          'highlight should align with vector text on the 270-degree source page',
        ).toBeGreaterThan(0);
        expect(
          yellowPixelCount(rasterPages[0]!, ensured.layoutMap.segments[1]!.rectangles),
          'presentation-excluded reference text should not be highlighted',
        ).toBe(0);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!POPPLER_AVAILABLE || !PDFIMAGES_AVAILABLE || !LIBREOFFICE_AVAILABLE)(
    'converts the synthetic DOCX locally and preserves its layout features and mapped text',
    async () => {
      const fixturePath = new URL(
        '../../test/fixtures/reports/original-fidelity/f0094-layout-fixture.docx',
        import.meta.url,
      );
      const source = await readFile(fixturePath);
      const texts = [
        'Mapped paragraph stays visible in the original layout.',
        'Second page mapping target stays exact.',
      ];
      const harness = rendererHarness(source);
      const ensured = await harness.renderer.ensure(
        originalInput(
          source,
          'synthetic-f0094-layout-fixture.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          texts,
        ),
      );

      expect(ensured.artifact.sourceType).toBe(OriginalRenderSourceType.DOCX);
      expect(ensured.artifact.fidelityStatus).toBe(
        OriginalRenderFidelityStatus.HIGH_FIDELITY_CONVERSION,
      );
      expect(ensured.artifact.pageCount).toBe(2);
      expect(ensured.layoutMap.segments.map((segment) => segment.mappingStatus)).toEqual([
        'LOCATED',
        'LOCATED',
      ]);
      expect(ensured.layoutMap.segments.map((segment) => segment.pageIndexes)).toEqual([
        [0],
        [1],
      ]);
      expect(ensured.artifact.expiresAt.getTime() - ensured.artifact.createdAt.getTime()).toBe(
        24 * 60 * 60 * 1000,
      );

      const directory = await mkdtemp(path.join(tmpdir(), 'turniting-f0094-docx-test-'));
      try {
        const convertedPath = path.join(directory, 'converted.pdf');
        await writeFile(convertedPath, ensured.buffer, { mode: 0o600, flag: 'wx' });
        const convertedText = await execFileAsync('pdftotext', ['-enc', 'UTF-8', convertedPath, '-'], {
          encoding: 'utf8',
          timeout: 15_000,
        });
        const convertedImages = await execFileAsync('pdfimages', ['-list', convertedPath], {
          encoding: 'utf8',
          timeout: 15_000,
        });
        expect(convertedImages.stdout).toMatch(/\n\s*\d+\s+\d+\s+image\s+/u);
        for (const expected of [
          'Synthetic thesis title',
          'SYNTHETIC HEADER',
          'SYNTHETIC FOOTER',
          'Bold fixture text',
          'italic fixture text',
          'Subscript',
          'Superscript',
          'Synthetic table cell',
          'Equation fixture',
          'References',
          ...texts,
        ]) {
          expect(convertedText.stdout).toContain(expected);
        }

        const report = await harness.renderer.renderOriginalReview(
          reportInput(texts.map((text, index) => reportParagraph(index, text, 0.58))),
          ensured.buffer,
          ensured.layoutMap,
        );
        const reviewedDocument = await PDFDocument.load(report);
        expect(reviewedDocument.getPageCount()).toBe(ensured.artifact.pageCount + 1);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
