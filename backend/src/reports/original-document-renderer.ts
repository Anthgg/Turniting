import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  OriginalRenderFidelityStatus,
  OriginalRenderSourceType,
  Prisma,
  type DocumentLayoutMap as DocumentLayoutMapRecord,
  type OriginalRenderArtifact as OriginalRenderArtifactRecord,
} from '@prisma/client';
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';
import { StorageService } from '../documents/storage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { REVIEW_HIGHLIGHT_THRESHOLD } from '../analysis/review-highlight-policy.js';
import { isPresentationExcluded, isReviewHighlighted, isTechnicalEvaluated, isTechnicalFlagged } from './technical-display.js';
import type {
  AIReportInput,
} from './report.contracts.js';
import {
  LAYOUT_EXTRACTION_ENGINE,
  LAYOUT_EXTRACTION_VERSION,
  ORIGINAL_DOCUMENT_RENDERER_VERSION,
  ORIGINAL_PDF_PASSTHROUGH_VERSION,
  REPORT_RETENTION_HOURS,
} from './report.constants.js';
import {
  REPORT_STORAGE,
  type ReportStorageAdapter,
} from './report-storage.js';

const MAPPING_ENGINE = 'sequential-exact-token-matching';
const MAPPING_VERSION = 'f00943-source-bound-sequential-mapping-v2';
const MAPPING_MIN_COVERAGE = 0.95;
const MAPPING_MIN_CONFIDENCE = 0.98;
const execFileAsync = promisify(execFile);

export interface LayoutSegmentInput {
  paragraphIndex: number;
  textHash: string;
  charStart: number;
  charEnd: number;
  text: string;
  flagged: boolean;
  reviewHighlighted?: boolean;
  presentationExcluded: boolean;
}

export interface LayoutRectangle {
  pageIndex: number;
  lineIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DocumentLayoutSegment {
  segmentId: number;
  pageIndexes: number[];
  rectangles: LayoutRectangle[];
  matchedTokenCount: number;
  totalTokenCount: number;
  mappingCoverage: number;
  mappingConfidence: number;
  mappingStatus:
    | 'LOCATED'
    | 'UNLOCATED'
    | 'FLAGGED_NOT_VISUALLY_LOCATED'
    | 'REVIEW_HIGHLIGHT_NOT_VISUALLY_LOCATED'
    | 'PRESENTATION_EXCLUDED';
}

export interface DocumentLayoutMap {
  version: string;
  source?: OriginalRenderSourceIdentity;
  pages: Array<{
    pageIndex: number;
    width: number;
    height: number;
  }>;
  segments: DocumentLayoutSegment[];
}

export interface OriginalRenderInput {
  sourceArtifactType: 'DOCUMENT_VERSION';
  documentId: string;
  documentVersionId: string;
  analysisRunId: string;
  storageKey: string;
  sourceChecksum: string;
  originalName: string;
  mimeType: string;
  segments: LayoutSegmentInput[];
}

export interface OriginalRenderSourceIdentity {
  sourceArtifactType: 'DOCUMENT_VERSION';
  documentId: string;
  documentVersionId: string;
  analysisRunId: string;
  sourceChecksum: string;
}

export interface OriginalRenderResult {
  source: OriginalRenderSourceIdentity;
  artifact: OriginalRenderArtifactRecord;
  buffer: Buffer;
  layoutMap: DocumentLayoutMap;
}

interface BboxWord {
  text: string;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  pageIndex: number;
  lineIndex: number;
}

interface BboxPage {
  pageIndex: number;
  words: BboxWord[];
}

interface HashedLayoutWord {
  tokenHash: string;
  joinNextHashes?: string[];
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  lineIndex: number;
}

interface HashedLayoutPage {
  pageIndex: number;
  width: number;
  height: number;
  words: HashedLayoutWord[];
}

interface RenderedSource {
  buffer: Buffer;
  sourceType: OriginalRenderSourceType;
  renderer: string;
  rendererVersion: string;
  fidelityStatus: OriginalRenderFidelityStatus;
}

@Injectable()
export class OriginalDocumentRenderer {
  private readonly logger = new Logger(OriginalDocumentRenderer.name);
  private readonly inFlight = new Map<
    string,
    Promise<OriginalRenderResult>
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: StorageService,
    @Inject(REPORT_STORAGE) private readonly reports: ReportStorageAdapter,
  ) {}

  async ensure(input: OriginalRenderInput): Promise<OriginalRenderResult> {
    this.assertDocumentVersionSource(input);
    const cacheKey = digest(
      JSON.stringify([
        input.documentVersionId,
        input.sourceChecksum,
        ORIGINAL_DOCUMENT_RENDERER_VERSION,
        ORIGINAL_PDF_PASSTHROUGH_VERSION,
        LAYOUT_EXTRACTION_VERSION,
      ]),
    );
    const cached = await this.readCachedRender(cacheKey, input);
    if (cached) {
      const layoutMap = await this.ensureLayoutMap(cached.artifact, input);
      return { ...cached, source: sourceIdentity(input), layoutMap };
    }

    const pending = this.inFlight.get(cacheKey);
    if (pending) {
      const rendered = await pending;
      this.assertArtifactSource(rendered.artifact, input);
      const layoutMap = await this.ensureLayoutMap(rendered.artifact, input);
      return { ...rendered, source: sourceIdentity(input), layoutMap };
    }

    const task = this.createRender(cacheKey, input);
    this.inFlight.set(cacheKey, task);
    try {
      return await task;
    } finally {
      if (this.inFlight.get(cacheKey) === task) {
        this.inFlight.delete(cacheKey);
      }
    }
  }

  async renderOriginalReview(
    input: AIReportInput,
    renderedSource: OriginalRenderResult,
  ): Promise<Buffer> {
    this.assertReviewSource(input, renderedSource);
    const { buffer: originalPdf, layoutMap } = renderedSource;
    const document = await PDFDocument.load(originalPdf);
    const cover = document.insertPage(0, [595.28, 841.89]);
    const regular = await document.embedFont(StandardFonts.Helvetica);
    const bold = await document.embedFont(StandardFonts.HelveticaBold);
    this.drawCover(cover, input, regular, bold);

    const paragraphs = new Map(
      input.paragraphs.map((paragraph) => [
        paragraph.paragraphIndex,
        paragraph,
      ]),
    );
    for (const mapped of layoutMap.segments) {
      const paragraph = paragraphs.get(mapped.segmentId);
      if (!paragraph || !isReviewHighlighted(paragraph)) {
        continue;
      }
      if (
        mapped.mappingStatus !== 'LOCATED' ||
        mapped.mappingCoverage < MAPPING_MIN_COVERAGE ||
        mapped.mappingConfidence < MAPPING_MIN_CONFIDENCE
      ) {
        continue;
      }
      for (const rectangle of mapped.rectangles) {
        const page = document.getPage(rectangle.pageIndex + 1);
        const layoutPage = layoutMap.pages[rectangle.pageIndex];
        const converted = toPdfRectangle(
          page,
          rectangle,
          layoutPage?.width ?? 1,
          layoutPage?.height ?? 1,
        );
        if (converted.width <= 0 || converted.height <= 0) continue;
        page.drawRectangle({
          ...converted,
          color: rgb(1, 0.84, 0.18),
          opacity: 0.2,
          borderOpacity: 0,
        });
      }
    }
    return Buffer.from(await document.save({ useObjectStreams: true }));
  }

  private async createRender(
    cacheKey: string,
    input: OriginalRenderInput,
  ): Promise<OriginalRenderResult> {
    const existing = await this.prisma.originalRenderArtifact.findUnique({
      where: { cacheKey },
    });
    const source = await this.documents.read(input.storageKey);
    if (digest(source) !== input.sourceChecksum) {
      throw new ConflictException({
        code: 'DOCUMENT_SOURCE_CHECKSUM_MISMATCH',
        message: 'El archivo fuente no coincide con la versión analizada.',
      });
    }

    const rendered = await this.renderSource(
      source,
      input.originalName,
      input.mimeType,
    );
    const bboxPages = await this.extractLayout(rendered.buffer);
    const pdf = await PDFDocument.load(rendered.buffer);
    if (pdf.getPageCount() < 1) {
      throw new Error('Original renderer produced a PDF without pages');
    }
    const layoutPages = padLayoutPages(
      bboxPages,
      pdf.getPages().map((page, pageIndex) => {
        const box = page.getCropBox();
        const angle = normalizeAngle(page.getRotation().angle);
        const rotated = angle === 90 || angle === 270;
        return {
          pageIndex,
          width: rotated ? box.height : box.width,
          height: rotated ? box.width : box.height,
        };
      }),
    );
    const now = new Date();
    const storageKey = randomUUID() + '.pdf';
    await this.reports.save(storageKey, rendered.buffer);
    let artifact: OriginalRenderArtifactRecord;
    try {
      const data = {
        documentId: input.documentId,
        documentVersionId: input.documentVersionId,
        sourceType: rendered.sourceType,
        sourceChecksum: input.sourceChecksum,
        renderer: rendered.renderer,
        rendererVersion: rendered.rendererVersion,
        layoutExtractionEngine: LAYOUT_EXTRACTION_ENGINE,
        layoutExtractionVersion: LAYOUT_EXTRACTION_VERSION,
        pageCount: pdf.getPageCount(),
        storageKey,
        renderChecksum: digest(rendered.buffer),
        fidelityStatus: rendered.fidelityStatus,
        layoutPages: layoutPages as unknown as Prisma.InputJsonValue,
        cacheKey,
        createdAt: now,
        expiresAt: new Date(
          now.getTime() + REPORT_RETENTION_HOURS * 60 * 60 * 1000,
        ),
        deletedAt: null,
      };
      if (existing) {
        await this.reports.delete(existing.storageKey).catch(() => false);
        artifact = await this.prisma.originalRenderArtifact.update({
          where: { id: existing.id },
          data,
        });
      } else {
        artifact = await this.prisma.originalRenderArtifact.create({ data });
      }
    } catch (error) {
      await this.reports.delete(storageKey).catch(() => false);
      throw error;
    }

    const layoutMap = await this.ensureLayoutMap(artifact, input);
    return { source: sourceIdentity(input), artifact, buffer: rendered.buffer, layoutMap };
  }

  private async readCachedRender(
    cacheKey: string,
    input: OriginalRenderInput,
  ): Promise<Pick<OriginalRenderResult, 'artifact' | 'buffer'> | null> {
    const now = new Date();
    const artifact = await this.prisma.originalRenderArtifact.findUnique({
      where: { cacheKey },
    });
    if (
      !artifact ||
      artifact.deletedAt ||
      artifact.expiresAt <= now ||
      !(await this.reports.exists(artifact.storageKey))
    ) {
      return null;
    }
    this.assertArtifactSource(artifact, input);
    try {
      const buffer = await this.reports.read(artifact.storageKey);
      if (digest(buffer) !== artifact.renderChecksum) return null;
      return { artifact, buffer };
    } catch {
      return null;
    }
  }

  private async ensureLayoutMap(
    artifact: OriginalRenderArtifactRecord,
    input: OriginalRenderInput,
  ): Promise<DocumentLayoutMap> {
    const segmentFingerprint = input.segments.map((segment) => [
      segment.paragraphIndex,
      segment.textHash,
      segment.charStart,
      segment.charEnd,
      segment.flagged,
      segment.reviewHighlighted === true,
      segment.presentationExcluded,
    ]);
    const cacheKey = digest(
      JSON.stringify([
        artifact.sourceChecksum,
        artifact.rendererVersion,
        artifact.layoutExtractionVersion,
        input.analysisRunId,
        segmentFingerprint,
        MAPPING_VERSION,
      ]),
    );
    const now = new Date();
    const cached = await this.prisma.documentLayoutMap.findUnique({
      where: { cacheKey },
    });
    if (cached && !cached.deletedAt && cached.expiresAt > now) {
      const layoutMap = cached.layoutMap as unknown as DocumentLayoutMap;
      if (
        cached.documentId !== input.documentId ||
        cached.documentVersionId !== input.documentVersionId ||
        cached.analysisRunId !== input.analysisRunId ||
        cached.originalRenderArtifactId !== artifact.id ||
        cached.sourceChecksum !== input.sourceChecksum ||
        !sameSourceIdentity(layoutMap.source, sourceIdentity(input))
      ) {
        this.integrityViolation('REPORT_SOURCE_INTEGRITY_VIOLATION', input);
      }
      return layoutMap;
    }

    const layoutMap = {
      ...mapSegments(
        artifact.layoutPages as unknown as HashedLayoutPage[],
        input.segments,
      ),
      source: sourceIdentity(input),
    };
    const data = {
      documentId: input.documentId,
      documentVersionId: input.documentVersionId,
      analysisRunId: input.analysisRunId,
      originalRenderArtifactId: artifact.id,
      sourceChecksum: artifact.sourceChecksum,
      rendererVersion: artifact.rendererVersion,
      layoutExtractionVersion: artifact.layoutExtractionVersion,
      mappingEngine: MAPPING_ENGINE,
      mappingVersion: MAPPING_VERSION,
      layoutMap: layoutMap as unknown as Prisma.InputJsonValue,
      cacheKey,
      createdAt: now,
      expiresAt: new Date(
        Math.min(
          artifact.expiresAt.getTime(),
          now.getTime() + REPORT_RETENTION_HOURS * 60 * 60 * 1000,
        ),
      ),
      deletedAt: null,
    };
    let record: DocumentLayoutMapRecord;
    if (cached) {
      record = await this.prisma.documentLayoutMap.update({
        where: { id: cached.id },
        data,
      });
    } else {
      record = await this.prisma.documentLayoutMap.create({ data });
    }
    return record.layoutMap as unknown as DocumentLayoutMap;
  }

  private assertDocumentVersionSource(input: OriginalRenderInput): void {
    if (!input || input.sourceArtifactType !== 'DOCUMENT_VERSION') {
      this.integrityViolation('REPORT_ARTIFACT_CANNOT_BE_DOCUMENT_SOURCE', input);
    }
    if (
      !input.documentId || !input.documentVersionId || !input.analysisRunId ||
      !/^[a-f0-9]{64}$/u.test(input.sourceChecksum)
    ) {
      this.integrityViolation('REPORT_SOURCE_INTEGRITY_VIOLATION', input);
    }
  }

  private assertArtifactSource(
    artifact: OriginalRenderArtifactRecord,
    input: Pick<OriginalRenderInput, 'documentId' | 'documentVersionId' | 'analysisRunId' | 'sourceChecksum'>,
  ): void {
    if (
      artifact.documentId !== input.documentId ||
      artifact.documentVersionId !== input.documentVersionId ||
      artifact.sourceChecksum !== input.sourceChecksum ||
      (artifact.sourceType === OriginalRenderSourceType.PDF &&
        artifact.renderChecksum !== artifact.sourceChecksum)
    ) {
      this.integrityViolation('REPORT_SOURCE_INTEGRITY_VIOLATION', input);
    }
  }

  private assertReviewSource(input: AIReportInput, rendered: OriginalRenderResult): void {
    const expected: OriginalRenderSourceIdentity = {
      sourceArtifactType: 'DOCUMENT_VERSION',
      documentId: input.document.id,
      documentVersionId: input.document.documentVersionId,
      analysisRunId: input.run.id,
      sourceChecksum: input.document.sourceChecksum,
    };
    if (rendered?.source?.sourceArtifactType !== 'DOCUMENT_VERSION') {
      this.integrityViolation('REPORT_ARTIFACT_CANNOT_BE_DOCUMENT_SOURCE', expected);
    }
    if (
      !sameSourceIdentity(rendered.source, expected) ||
      !sameSourceIdentity(rendered.layoutMap.source, expected) ||
      digest(rendered.buffer) !== rendered.artifact.renderChecksum
    ) {
      this.integrityViolation('REPORT_SOURCE_INTEGRITY_VIOLATION', expected);
    }
    this.assertArtifactSource(rendered.artifact, expected);
  }

  private integrityViolation(
    code: 'REPORT_ARTIFACT_CANNOT_BE_DOCUMENT_SOURCE' | 'REPORT_SOURCE_INTEGRITY_VIOLATION',
    input: Partial<OriginalRenderInput> | undefined,
  ): never {
    this.logger.warn(JSON.stringify({
      event: 'report_source_integrity_violation',
      code,
      documentId: input?.documentId,
      documentVersionId: input?.documentVersionId,
      analysisRunId: input?.analysisRunId,
      sourceArtifactType: input?.sourceArtifactType,
      sourceChecksumPrefix: input?.sourceChecksum?.slice(0, 12),
    }));
    throw new ConflictException({ code, message: 'La fuente del reporte no corresponde a la versión del documento analizado.' });
  }

  private async renderSource(
    source: Buffer,
    originalName: string,
    mimeType: string,
  ): Promise<RenderedSource> {
    const extension = path.extname(originalName).toLowerCase();
    const isPdf =
      mimeType.toLowerCase() === 'application/pdf' || extension === '.pdf';
    if (isPdf) {
      return {
        buffer: source,
        sourceType: OriginalRenderSourceType.PDF,
        renderer: 'SOURCE_PDF',
        rendererVersion: ORIGINAL_PDF_PASSTHROUGH_VERSION,
        fidelityStatus: OriginalRenderFidelityStatus.EXACT_SOURCE_PDF,
      };
    }
    const isDocx =
      mimeType.toLowerCase() ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      extension === '.docx';
    if (!isDocx) {
      throw new ConflictException({
        code: 'ORIGINAL_RENDER_UNSUPPORTED_SOURCE',
        message: 'La revisión original requiere un archivo PDF o DOCX.',
      });
    }
    const buffer = await this.convertDocx(source);
    return {
      buffer,
      sourceType: OriginalRenderSourceType.DOCX,
      renderer: 'LibreOffice Writer',
      rendererVersion: ORIGINAL_DOCUMENT_RENDERER_VERSION,
      fidelityStatus: OriginalRenderFidelityStatus.HIGH_FIDELITY_CONVERSION,
    };
  }

  private async convertDocx(source: Buffer): Promise<Buffer> {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'turniting-f0094-render-'),
    );
    const inputPath = path.join(directory, 'source.docx');
    const outputPath = path.join(directory, 'source.pdf');
    const profilePath = path.join(directory, 'lo-profile');
    try {
      await writeFile(inputPath, source, { mode: 0o600, flag: 'wx' });
      await execFileAsync(
        'soffice',
        [
          '-env:UserInstallation=file://' + profilePath.replace(/\\/g, '/'),
          '--headless',
          '--convert-to',
          'pdf',
          '--outdir',
          directory,
          inputPath,
        ],
        { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
      );
      const output = await readFile(outputPath);
      if (output.length < 8 || output.toString('ascii', 0, 5) !== '%PDF-') {
        throw new Error('LibreOffice did not produce a valid PDF');
      }
      return output;
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as NodeJS.ErrnoException).code ?? '')
          : '';
      if (code === 'ENOENT') {
        throw new Error('LibreOffice Writer is unavailable in the backend image');
      }
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async extractLayout(pdf: Buffer): Promise<BboxPage[]> {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'turniting-f0094-layout-'),
    );
    const pdfPath = path.join(directory, 'render.pdf');
    try {
      await writeFile(pdfPath, pdf, { mode: 0o600, flag: 'wx' });
      const { stdout } = await execFileAsync(
        'pdftotext',
        ['-bbox-layout', '-enc', 'UTF-8', pdfPath, '-'],
        {
          encoding: 'utf8',
          timeout: 120_000,
          maxBuffer: 128 * 1024 * 1024,
        },
      );
      return parseBboxLayout(String(stdout));
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as NodeJS.ErrnoException).code ?? '')
          : '';
      if (code === 'ENOENT') {
        throw new Error('Poppler pdftotext is unavailable in the backend image');
      }
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private drawCover(
    page: PDFPage,
    input: AIReportInput,
    regular: PDFFont,
    bold: PDFFont,
  ): void {
    const ink = rgb(0.12, 0.16, 0.21);
    const muted = rgb(0.37, 0.41, 0.46);
    page.drawText('TURNITING', {
      x: 56,
      y: 752,
      size: 24,
      font: bold,
      color: ink,
    });
    page.drawText('Reporte independiente de señal de IA', {
      x: 56,
      y: 716,
      size: 16,
      font: bold,
      color: ink,
    });

    const evaluated = input.paragraphs.filter(isTechnicalEvaluated).length;
    const highlighted = input.paragraphs.filter(isReviewHighlighted).length;
    const rawFlagged = input.paragraphs.filter((paragraph) =>
      isTechnicalFlagged(paragraph, input.run.threshold),
    ).length;
    const excludedFlagged = input.paragraphs.filter((paragraph) =>
      isTechnicalFlagged(paragraph, input.run.threshold) && isPresentationExcluded(paragraph),
    ).length;
    const summary = [
      ['Documento', input.document.filename],
      ['Señal global estimada', formatPercent(input.run.documentScore)],
      ['Umbral detector', formatPercent(input.run.threshold)],
      ['Umbral revisión visual', `>${formatPercent(REVIEW_HIGHLIGHT_THRESHOLD)}`],
      ['Modelo', input.run.modelNames.join(' + ') || input.run.analyzerMode],
      ['Segmentos totales', String(input.paragraphs.length)],
      ['Segmentos evaluados', String(evaluated)],
      ['Señalados por detector', String(rawFlagged)],
      ['Resaltados para revisión', String(highlighted)],
      ['Señalados excluidos', String(excludedFlagged)],
      [
        'Fecha',
        input.generatedAt.toLocaleString('es-PE', {
          timeZone: 'America/Lima',
        }),
      ],
    ] as const;
    let y = 660;
    for (const [label, value] of summary) {
      page.drawText(label, {
        x: 56,
        y,
        size: 10,
        font: bold,
        color: muted,
      });
      page.drawText(value, {
        x: 220,
        y,
        size: 10,
        font: regular,
        color: ink,
        maxWidth: 330,
      });
      y -= 32;
    }
    const notice =
      'Turniting proporciona una estimación probabilística independiente. No constituye un reporte oficial de Turnitin ni prueba por sí solo la autoría o el uso de inteligencia artificial.';
    drawWrappedText(page, notice, regular, 56, 288, 500, 10, 15, muted);
    const reviewNotice = `El resaltado visual se aplica a segmentos evaluados con una señal local superior al ${formatPercent(REVIEW_HIGHLIGHT_THRESHOLD)}. Este criterio de revisión es independiente del umbral de clasificación del modelo.`;
    drawWrappedText(page, reviewNotice, regular, 56, 220, 500, 10, 15, muted);
  }
}

export function mapSegments(
  pages: HashedLayoutPage[],
  segments: LayoutSegmentInput[],
): DocumentLayoutMap {
  const flatWords = pages.flatMap((page) =>
    page.words.map((word) => ({ ...word, pageIndex: page.pageIndex })),
  );
  const startsByToken = buildStartIndex(flatWords);
  const result: DocumentLayoutSegment[] = [];
  let cursor = 0;

  for (const segment of [...segments].sort(
    (left, right) => left.paragraphIndex - right.paragraphIndex,
  )) {
    const tokens = segment.text.match(/\S+/gu) ?? [];
    const tokenHashes = tokens.map(hashToken);
    const indexes =
      tokenHashes.length > 0
        ? startsByToken.get(tokenHashes[0]) ?? []
        : [];
    let matchedIndexes: number[][] | null = null;
    for (const start of indexes) {
      if (start < cursor) continue;
      const candidate = matchTokenSequence(flatWords, tokenHashes, start);
      if (candidate) {
        matchedIndexes = candidate;
        break;
      }
    }

    const matched = matchedIndexes ?? [];
    const matchedWords = matched.flat();
    const coverage =
      tokenHashes.length > 0 ? matched.length / tokenHashes.length : 0;
    const confidence = matched.length === tokenHashes.length ? 1 : 0;
    const located =
      coverage >= MAPPING_MIN_COVERAGE &&
      confidence >= MAPPING_MIN_CONFIDENCE &&
      tokenHashes.length > 0;
    const rectangles = located
      ? groupLineRectangles(matchedWords.map((index) => flatWords[index]))
      : [];
    const pageIndexes = [...new Set(rectangles.map((item) => item.pageIndex))];
    result.push({
      segmentId: segment.paragraphIndex,
      pageIndexes,
      rectangles,
      matchedTokenCount: located ? matched.length : 0,
      totalTokenCount: tokenHashes.length,
      mappingCoverage: located ? coverage : 0,
      mappingConfidence: located ? confidence : 0,
      mappingStatus: located
        ? segment.presentationExcluded
          ? 'PRESENTATION_EXCLUDED'
          : 'LOCATED'
        : segment.reviewHighlighted === true && !segment.presentationExcluded
          ? 'REVIEW_HIGHLIGHT_NOT_VISUALLY_LOCATED'
          : 'UNLOCATED',
    });
    if (located && matchedIndexes) {
      cursor = matchedWords[matchedWords.length - 1] + 1;
    }
  }

  return {
    version: MAPPING_VERSION,
    pages: pages.map(({ pageIndex, width, height }) => ({
      pageIndex,
      width,
      height,
    })),
    segments: result,
  };
}

function sourceIdentity(input: OriginalRenderInput): OriginalRenderSourceIdentity {
  return {
    sourceArtifactType: 'DOCUMENT_VERSION',
    documentId: input.documentId,
    documentVersionId: input.documentVersionId,
    analysisRunId: input.analysisRunId,
    sourceChecksum: input.sourceChecksum,
  };
}

function sameSourceIdentity(
  source: OriginalRenderSourceIdentity | undefined,
  expected: OriginalRenderSourceIdentity,
): boolean {
  return Boolean(source &&
    source.sourceArtifactType === 'DOCUMENT_VERSION' &&
    source.documentId === expected.documentId &&
    source.documentVersionId === expected.documentVersionId &&
    source.analysisRunId === expected.analysisRunId &&
    source.sourceChecksum === expected.sourceChecksum);
}

function parseBboxLayout(xml: string): BboxPage[] {
  const pages: BboxPage[] = [];
  const pagePattern = /<page\b([^>]*)>([\s\S]*?)<\/page>/gu;
  let pageMatch: RegExpExecArray | null;
  while ((pageMatch = pagePattern.exec(xml))) {
    const pageIndex = pages.length;
    const pageBody = pageMatch[2];
    const words: BboxWord[] = [];
    const linePattern = /<line\b[^>]*>([\s\S]*?)<\/line>/gu;
    let lineMatch: RegExpExecArray | null;
    let lineIndex = 0;
    while ((lineMatch = linePattern.exec(pageBody))) {
      appendLineWords(lineMatch[1], pageIndex, lineIndex, words);
      lineIndex += 1;
    }
    if (lineIndex === 0) {
      appendLineWords(pageBody, pageIndex, 0, words);
    }
    pages.push({
      pageIndex,
      words,
    });
  }
  return pages;
}

function appendLineWords(
  lineXml: string,
  pageIndex: number,
  lineIndex: number,
  target: BboxWord[],
): void {
  const wordPattern = /<word\b([^>]*)>([\s\S]*?)<\/word>/gu;
  let wordMatch: RegExpExecArray | null;
  while ((wordMatch = wordPattern.exec(lineXml))) {
    const attributes = parseAttributes(wordMatch[1]);
    const text = decodeXml(wordMatch[2].replace(/<[^>]+>/gu, '')).trim();
    if (!text) continue;
    target.push({
      text,
      xMin: numeric(attributes.xMin),
      yMin: numeric(attributes.yMin),
      xMax: numeric(attributes.xMax),
      yMax: numeric(attributes.yMax),
      pageIndex,
      lineIndex,
    });
  }
}

function padLayoutPages(
  pages: BboxPage[],
  geometry: Array<{ pageIndex: number; width: number; height: number }>,
): HashedLayoutPage[] {
  return geometry.map((page) => {
    const source = pages[page.pageIndex];
    const rawWords = source?.words ?? [];
    const words: HashedLayoutWord[] = rawWords.map((word, index) => {
      const next = rawWords[index + 1];
      let joinNextHashes: string[] | undefined;
      if (next && word.lineIndex !== next.lineIndex && /[-\u2010\u2011\u2012\u2013\u2014]$/u.test(word.text)) {
        const withoutHyphen = word.text.replace(/[-\u2010\u2011\u2012\u2013\u2014]$/u, '');
        joinNextHashes = [
          hashToken(withoutHyphen + next.text),
          hashToken(word.text + next.text),
        ];
      }
      return {
        tokenHash: hashToken(word.text),
        ...(joinNextHashes ? { joinNextHashes } : {}),
        xMin: word.xMin,
        yMin: word.yMin,
        xMax: word.xMax,
        yMax: word.yMax,
        lineIndex: word.lineIndex,
      };
    });
    return {
      pageIndex: page.pageIndex,
      // Poppler rotates word boxes for rotated pages but leaves page width/height
      // metadata in the unrotated orientation. PDF geometry is authoritative.
      width: page.width,
      height: page.height,
      words,
    };
  });
}

function buildStartIndex(
  words: Array<HashedLayoutWord & { pageIndex: number }>,
): Map<string, number[]> {
  const result = new Map<string, number[]>();
  const add = (hash: string, index: number) => {
    const positions = result.get(hash) ?? [];
    positions.push(index);
    result.set(hash, positions);
  };
  words.forEach((word, index) => {
    add(word.tokenHash, index);
    for (const joined of word.joinNextHashes ?? []) add(joined, index);
  });
  return result;
}

function matchTokenSequence(
  words: Array<HashedLayoutWord & { pageIndex: number }>,
  tokens: string[],
  start: number,
): number[][] | null {
  const matched: number[][] = [];
  let wordIndex = start;
  for (const token of tokens) {
    const word = words[wordIndex];
    if (!word) return null;
    if (word.tokenHash === token) {
      matched.push([wordIndex]);
      wordIndex += 1;
      continue;
    }
    if (word.joinNextHashes?.includes(token) && words[wordIndex + 1]) {
      matched.push([wordIndex, wordIndex + 1]);
      wordIndex += 2;
      continue;
    }
    return null;
  }
  return matched;
}

function groupLineRectangles(
  words: Array<HashedLayoutWord & { pageIndex: number }>,
): LayoutRectangle[] {
  const groups = new Map<string, BboxWord>();
  for (const word of words) {
    const key = word.pageIndex + ':' + word.lineIndex;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        text: '',
        xMin: word.xMin,
        yMin: word.yMin,
        xMax: word.xMax,
        yMax: word.yMax,
        pageIndex: word.pageIndex,
        lineIndex: word.lineIndex,
      });
      continue;
    }
    existing.xMin = Math.min(existing.xMin, word.xMin);
    existing.yMin = Math.min(existing.yMin, word.yMin);
    existing.xMax = Math.max(existing.xMax, word.xMax);
    existing.yMax = Math.max(existing.yMax, word.yMax);
  }
  return [...groups.values()]
    .map((box) => ({
      pageIndex: box.pageIndex,
      lineIndex: box.lineIndex,
      x: round(box.xMin),
      y: round(box.yMin),
      width: round(box.xMax - box.xMin),
      height: round(box.yMax - box.yMin),
    }))
    .sort(
      (left, right) =>
        left.pageIndex - right.pageIndex ||
        left.lineIndex - right.lineIndex,
    );
}

function toPdfRectangle(
  page: PDFPage,
  rectangle: LayoutRectangle,
  layoutWidth: number,
  layoutHeight: number,
): { x: number; y: number; width: number; height: number } {
  const crop = page.getCropBox();
  const angle = normalizeAngle(page.getRotation().angle);
  const visualWidth =
    angle === 90 || angle === 270 ? crop.height : crop.width;
  const visualHeight =
    angle === 90 || angle === 270 ? crop.width : crop.height;
  const layoutPageScaleX = visualWidth / Math.max(1, layoutWidth);
  const layoutPageScaleY = visualHeight / Math.max(1, layoutHeight);
  const x = rectangle.x * layoutPageScaleX;
  const y = rectangle.y * layoutPageScaleY;
  const width = rectangle.width * layoutPageScaleX;
  const height = rectangle.height * layoutPageScaleY;
  if (angle === 90) {
    return {
      x: crop.x + y,
      y: crop.y + x,
      width: height,
      height: width,
    };
  }
  if (angle === 180) {
    return {
      x: crop.x + crop.width - x - width,
      y: crop.y + y,
      width,
      height,
    };
  }
  if (angle === 270) {
    return {
      x: crop.x + crop.width - y - height,
      y: crop.y + crop.height - x - width,
      width: height,
      height: width,
    };
  }
  return {
    x: crop.x + x,
    y: crop.y + crop.height - y - height,
    width,
    height,
  };
}

function drawWrappedText(
  page: PDFPage,
  text: string,
  font: PDFFont,
  x: number,
  y: number,
  maxWidth: number,
  fontSize: number,
  lineHeight: number,
  color: ReturnType<typeof rgb>,
): number {
  let currentLine = '';
  let currentY = y;
  for (const word of text.split(/\s+/u)) {
    const candidate = currentLine ? currentLine + ' ' + word : word;
    if (
      currentLine &&
      font.widthOfTextAtSize(candidate, fontSize) > maxWidth
    ) {
      page.drawText(currentLine, {
        x,
        y: currentY,
        size: fontSize,
        font,
        color,
      });
      currentLine = word;
      currentY -= lineHeight;
    } else {
      currentLine = candidate;
    }
  }
  if (currentLine) {
    page.drawText(currentLine, {
      x,
      y: currentY,
      size: fontSize,
      font,
      color,
    });
    currentY -= lineHeight;
  }
  return currentY;
}

function formatPercent(value: number | null): string {
  return value === null ? 'No disponible' : (value * 100).toFixed(1) + ' %';
}

function parseAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([\w:-]+)="([^"]*)"/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) attributes[match[1]] = match[2];
  return attributes;
}

function decodeXml(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu,
    (entity, name: string) => {
      if (name === 'amp') return '&';
      if (name === 'lt') return '<';
      if (name === 'gt') return '>';
      if (name === 'quot') return '"';
      if (name === 'apos') return "'";
      const codePoint = name.startsWith('#x')
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(codePoint)
        ? String.fromCodePoint(codePoint)
        : entity;
    },
  );
}

function normalizeToken(value: string): string {
  return value.normalize('NFC').replace(/\u00ad/gu, '').toLowerCase();
}

function hashToken(value: string): string {
  return digest(normalizeToken(value));
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function numeric(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeAngle(value: number): number {
  return ((value % 360) + 360) % 360;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
