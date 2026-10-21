import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, StandardFonts } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { createSourceIntegrityFixture, sha256, FIXTURE_IDS } from '../../test/fixtures/reports/source-integrity/fixture.mjs';
import type { AIReportInput } from './report.contracts.js';
import { OriginalDocumentRenderer, type OriginalRenderInput } from './original-document-renderer.js';
import { ReportRenderer } from './report-renderer.js';
import { stampTurnitingReport } from './report-pdf-metadata.js';

function harness(source: Buffer) {
  const renders = new Map<string, any>();
  const maps = new Map<string, any>();
  const files = new Map<string, Buffer>();
  const prisma = {
    originalRenderArtifact: {
      findUnique: vi.fn(async ({ where }: any) => renders.get(where.cacheKey) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const record = { id: 'f0094100-0000-4000-8000-000000000006', ...data };
        renders.set(data.cacheKey, record);
        return record;
      }),
    },
    documentLayoutMap: {
      findUnique: vi.fn(async ({ where }: any) => maps.get(where.cacheKey) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const record = { id: 'f0094100-0000-4000-8000-000000000007', ...data };
        maps.set(data.cacheKey, record);
        return record;
      }),
    },
  };
  const documents = { read: vi.fn(async () => source) };
  const reports = {
    save: vi.fn(async (key: string, bytes: Buffer) => { files.set(key, bytes); }),
    read: vi.fn(async (key: string) => files.get(key)!),
    exists: vi.fn(async (key: string) => files.has(key)),
    delete: vi.fn(async (key: string) => files.delete(key)),
  };
  const renderer = new OriginalDocumentRenderer(prisma as never, documents as never, reports as never);
  return { renderer, prisma, documents, reports, renders, maps, files };
}

function renderInput(input: AIReportInput): OriginalRenderInput {
  return {
    sourceArtifactType: 'DOCUMENT_VERSION',
    documentId: input.document.id,
    documentVersionId: input.document.documentVersionId,
    analysisRunId: input.run.id,
    storageKey: input.document.storageKey,
    sourceChecksum: input.document.sourceChecksum,
    originalName: input.document.filename,
    mimeType: input.document.mimeType,
    segments: input.paragraphs.map((paragraph) => ({
      paragraphIndex: paragraph.paragraphIndex,
      textHash: paragraph.textHash,
      charStart: paragraph.charStart,
      charEnd: paragraph.charEnd,
      text: paragraph.textPreview,
      flagged: paragraph.score !== null && paragraph.score >= input.run.threshold!,
      presentationExcluded: Boolean(paragraph.presentationExcluded),
    })),
  };
}

function contentHashes(document: PDFDocument, pageIndex: number): string[] {
  const contents = document.getPage(pageIndex).node.lookup(PDFName.of('Contents'));
  const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
  return streams.map((item) => document.context.lookup(item))
    .filter((item): item is PDFRawStream => item instanceof PDFRawStream)
    .map((stream) => sha256(Buffer.from(stream.contents)));
}

function pageContentText(document: PDFDocument, pageIndex: number): string {
  const contents = document.getPage(pageIndex).node.lookup(PDFName.of('Contents'));
  const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
  return streams.map((item) => document.context.lookup(item))
    .filter((item): item is PDFRawStream => item instanceof PDFRawStream)
    .map((stream) => {
      const filter = stream.dict.get(PDFName.of('Filter'))?.toString();
      return (filter === '/FlateDecode' ? inflateSync(stream.contents) : Buffer.from(stream.contents)).toString('latin1');
    }).join('\n');
}

function hasPoppler(): boolean {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

describe('F009.4.1 renderer source boundary', () => {
  it('rejects a ReportArtifact before consulting render cache or document storage', async () => {
    const fixture = await createSourceIntegrityFixture();
    const tested = harness(fixture.source);
    const forged = { ...renderInput(fixture.input), sourceArtifactType: 'REPORT_ARTIFACT' };
    await expect(tested.renderer.ensure(forged as never)).rejects.toMatchObject({
      response: { code: 'REPORT_ARTIFACT_CANNOT_BE_DOCUMENT_SOURCE' },
    });
    expect(tested.prisma.originalRenderArtifact.findUnique).not.toHaveBeenCalled();
    expect(tested.documents.read).not.toHaveBeenCalled();
    expect(tested.reports.save).not.toHaveBeenCalled();
  });

  it('rejects a source without an explicit DocumentVersion discriminant', async () => {
    const fixture = await createSourceIntegrityFixture();
    const tested = harness(fixture.source);
    const { sourceArtifactType: _sourceArtifactType, ...ambiguous } = renderInput(fixture.input);
    await expect(tested.renderer.ensure(ambiguous as never)).rejects.toMatchObject({
      response: { code: 'REPORT_ARTIFACT_CANNOT_BE_DOCUMENT_SOURCE' },
    });
  });

  it('rejects a cached render associated with a different original document version', async () => {
    const fixture = await createSourceIntegrityFixture();
    const tested = harness(fixture.source);
    tested.prisma.originalRenderArtifact.findUnique.mockResolvedValue({
      documentId: fixture.input.document.id,
      documentVersionId: 'f0094100-0000-4000-8000-000000000099',
      sourceChecksum: fixture.input.document.sourceChecksum,
      sourceType: 'PDF', renderChecksum: fixture.input.document.sourceChecksum,
      deletedAt: null, expiresAt: new Date('2099-01-01'), storageKey: 'cached.pdf',
    } as never);
    tested.files.set('cached.pdf', fixture.source);
    await expect(tested.renderer.ensure(renderInput(fixture.input))).rejects.toMatchObject({
      response: { code: 'REPORT_SOURCE_INTEGRITY_VIOLATION' },
    });
    expect(tested.documents.read).not.toHaveBeenCalled();
  });

  it('binds the render and layout to the exact run and checksum before opening PDF bytes', async () => {
    const fixture = await createSourceIntegrityFixture();
    const tested = harness(fixture.source);
    const identity = { sourceArtifactType: 'DOCUMENT_VERSION' as const, documentId: fixture.input.document.id, documentVersionId: fixture.input.document.documentVersionId, analysisRunId: fixture.input.run.id, sourceChecksum: fixture.input.document.sourceChecksum };
    const artifact = { documentId: identity.documentId, documentVersionId: identity.documentVersionId, sourceChecksum: identity.sourceChecksum, renderChecksum: sha256(fixture.source), sourceType: 'PDF' };
    const rendered = { source: identity, artifact, buffer: fixture.source, layoutMap: { version: 'test', source: identity, pages: [], segments: [] } };
    for (const altered of [
      { ...rendered, source: { ...identity, sourceArtifactType: 'REPORT_ARTIFACT' } },
      { ...rendered, source: { ...identity, analysisRunId: 'other-run' } },
      { ...rendered, layoutMap: { ...rendered.layoutMap, source: { ...identity, documentVersionId: 'other-version' } } },
      { ...rendered, buffer: Buffer.from('technical report bytes') },
    ]) {
      await expect(tested.renderer.renderOriginalReview(fixture.input, altered as never)).rejects.toMatchObject({
        response: { code: expect.stringMatching(/REPORT_ARTIFACT_CANNOT_BE_DOCUMENT_SOURCE|REPORT_SOURCE_INTEGRITY_VIOLATION/u) },
      });
    }
  });

  it('marks each PDF with its report identity while retaining original page streams', async () => {
    const source = await PDFDocument.create();
    const font = await source.embedFont(StandardFonts.Helvetica);
    source.addPage().drawText('Synthetic source text', { x: 30, y: 700, size: 12, font });
    const bytes = Buffer.from(await source.save());
    const before = await PDFDocument.load(bytes);
    const marker = { reportId: FIXTURE_IDS.technicalReportId, reportVariant: 'AI_PARAGRAPH_TECHNICAL' as const, analysisRunId: FIXTURE_IDS.analysisRunId, sourceDocumentId: FIXTURE_IDS.documentId, sourceDocumentVersionId: FIXTURE_IDS.documentVersionId, rendererVersion: 'synthetic-test-v1' };
    const after = await PDFDocument.load(await stampTurnitingReport(bytes, marker), { updateMetadata: false });
    expect(after.getProducer()).toBe('TURNITING');
    const info = after.context.lookup(after.context.trailerInfo.Info) as any;
    for (const [name, value] of Object.entries({ generatedBy: 'TURNITING', ...marker })) {
      expect(info.lookup(PDFName.of(`turniting.${name}`)).decodeText()).toBe(value);
    }
    expect(contentHashes(after, 0)).toEqual(contentHashes(before, 0));
  });
});

describe('F009.4.1 persisted synthetic report sequence', () => {
  it.skipIf(!hasPoppler())('renders exact persisted body scores with paragraphs 1, 3, 4 and 5 highlighted for review', async () => {
    const fixture = await createSourceIntegrityFixture();
    const input: AIReportInput = {
      ...fixture.input,
      run: { ...fixture.input.run, id: 'f0094100-0000-4000-8000-000000000008', scoredSegments: 5, insufficientSegments: 0 },
      paragraphs: fixture.input.paragraphs.slice(1, 6).map((paragraph, paragraphIndex) => ({
        ...paragraph,
        kind: 'PARAGRAPH',
        paragraphIndex,
        segmentEvidence: { ...paragraph.segmentEvidence, paragraphId: paragraphIndex },
      })),
    };
    expect(input.paragraphs.map((paragraph) => paragraph.score)).toEqual([0.8, 0.2, 0.61, 0.4, 0.9]);
    const tested = harness(fixture.source);
    const rendered = await tested.renderer.ensure(renderInput(input));
    expect(rendered.buffer).toEqual(fixture.source);
    expect(rendered.layoutMap.source?.analysisRunId).toBe(input.run.id);
    expect(rendered.layoutMap.segments.map((segment) => segment.pageIndexes)).toEqual([[1], [2], [3], [4], [5]]);
    expect(rendered.layoutMap.segments.filter((segment) => segment.mappingStatus === 'LOCATED' && input.paragraphs[segment.segmentId]!.score! >= input.run.threshold!).map((segment) => segment.segmentId)).toEqual([0, 2, 4]);
    const review = await tested.renderer.renderOriginalReview(input, rendered);
    const reviewPdf = await PDFDocument.load(review);
    const highlightedSourcePages = Array.from({ length: 18 }, (_, sourcePage) => sourcePage)
      .filter((sourcePage) => pageContentText(reviewPdf, sourcePage + 1).includes('1 0.84 0.18 rg'));
    expect(highlightedSourcePages).toEqual([1, 3, 4, 5]);
    const technical = await new ReportRenderer().renderAIParagraphTechnical(input);
    const directory = await mkdtemp(path.join(tmpdir(), 'turniting-f00941-five-body-'));
    try {
      await writeFile(path.join(directory, 'review.pdf'), review);
      await writeFile(path.join(directory, 'technical.pdf'), technical);
      const technicalText = execFileSync('pdftotext', ['-enc', 'UTF-8', path.join(directory, 'technical.pdf'), '-'], { encoding: 'utf8', timeout: 15_000 });
      const reviewText = execFileSync('pdftotext', ['-enc', 'UTF-8', path.join(directory, 'review.pdf'), '-'], { encoding: 'utf8', timeout: 15_000 });
      const cards = [...technicalText.matchAll(/PÁRRAFO\s+(\d+)([\s\S]*?)(?=PÁRRAFO\s+\d+|$)/gu)];
      expect(cards).toHaveLength(5);
      for (let index = 0; index < cards.length; index += 1) {
        expect(cards[index]![1]).toBe(String(index + 1));
        expect(cards[index]![2]).toContain((input.paragraphs[index]!.score! * 100).toFixed(1) + ' %');
      }
      expect(reviewText).toContain('43.4 %');
      expect(technicalText).toContain('43.4 %');
      expect(reviewText).toContain('59.0 %');
      expect(technicalText).toContain('59.0 %');
      const sourcePagesText = reviewText.split('\f').slice(1).join(' ');
      for (const localPercent of ['80.0 %', '20.0 %', '61.0 %', '40.0 %', '90.0 %']) expect(sourcePagesText).not.toContain(localPercent);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(!hasPoppler())('keeps 18 original source pages after technical generation and both regenerations', async () => {
    const fixture = await createSourceIntegrityFixture();
    const input = fixture.input as AIReportInput;
    const snapshot = JSON.stringify(input);
    expect(input.paragraphs).toHaveLength(12);
    expect(input.paragraphs.filter((item) => item.score === null)).toHaveLength(2);
    const tested = harness(fixture.source);
    const technicalRenderer = new ReportRenderer();
    const marker = { analysisRunId: input.run.id, sourceDocumentId: input.document.id, sourceDocumentVersionId: input.document.documentVersionId, rendererVersion: 'synthetic-regression-v1' };
    const technicals: Buffer[] = [];
    const reviews: Buffer[] = [];
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const technical = await stampTurnitingReport(await technicalRenderer.renderAIParagraphTechnical({ ...input, reportId: FIXTURE_IDS.technicalReportId }), { ...marker, reportId: FIXTURE_IDS.technicalReportId, reportVariant: 'AI_PARAGRAPH_TECHNICAL' });
      technicals.push(technical);
      const ensured = await tested.renderer.ensure(renderInput(input));
      expect(ensured.buffer).toEqual(fixture.source);
      expect(sha256(ensured.buffer)).toBe(input.document.sourceChecksum);
      expect(sha256(ensured.buffer)).not.toBe(sha256(technical));
      expect(ensured.layoutMap.source).toMatchObject({ analysisRunId: input.run.id, documentVersionId: input.document.documentVersionId });
      const actionable = ensured.layoutMap.segments.filter((mapped) => mapped.mappingStatus === 'LOCATED' && input.paragraphs[mapped.segmentId]!.score! >= input.run.threshold!);
      expect(actionable).toHaveLength(fixture.expectedActionableFlagged);
      const review = await stampTurnitingReport(await tested.renderer.renderOriginalReview(input, ensured), { ...marker, reportId: input.reportId, reportVariant: 'AI_ORIGINAL_REVIEW' });
      reviews.push(review);
      const originalPdf = await PDFDocument.load(fixture.source);
      const technicalPdf = await PDFDocument.load(technical);
      const reviewPdf = await PDFDocument.load(review);
      expect(reviewPdf.getPageCount()).toBe(19);
      const technicalHashes = technicalPdf.getPages().flatMap((_, pageIndex) => contentHashes(technicalPdf, pageIndex));
      for (let sourcePage = 0; sourcePage < 18; sourcePage += 1) {
        const originalHashes = contentHashes(originalPdf, sourcePage);
        const reviewHashes = contentHashes(reviewPdf, sourcePage + 1);
        expect(originalHashes.every((hash) => reviewHashes.includes(hash))).toBe(true);
        expect(reviewHashes.some((hash) => technicalHashes.includes(hash))).toBe(false);
      }
      const directory = await mkdtemp(path.join(tmpdir(), 'turniting-f00941-source-test-'));
      try {
        await writeFile(path.join(directory, 'review.pdf'), review);
        await writeFile(path.join(directory, 'technical.pdf'), technical);
        const reviewText = execFileSync('pdftotext', ['-enc', 'UTF-8', path.join(directory, 'review.pdf'), '-'], { encoding: 'utf8', timeout: 15_000 });
        const technicalText = execFileSync('pdftotext', ['-enc', 'UTF-8', path.join(directory, 'technical.pdf'), '-'], { encoding: 'utf8', timeout: 15_000 });
        expect(reviewText).toContain('thesis-fixture.pdf');
        expect(reviewText).toContain('43.4 %');
        expect(reviewText).toContain('59.0 %');
        expect(reviewText).not.toContain('80.0 %');
        expect(reviewText).not.toContain('turniting_paragraph-technical_');
        expect(technicalText).toContain('43.4 %');
        expect(technicalText).toContain('59.0 %');
        for (const percent of ['80.0 %', '20.0 %', '61.0 %', '40.0 %', '90.0 %']) expect(technicalText).toContain(percent);
        expect(technicalText.match(/Señal local estimada: NO EVALUADO/gu)).toHaveLength(2);
        expect(technicalText.match(/(?:PÁRRAFO|SEGMENTO) \d+/gu)).toHaveLength(12);
        const canonicalTechnicalText = technicalText
          .replace(/Turniting\s*\|\s*Reporte independiente\s*\|\s*Página\s+\d+\s+de\s+\d+/gu, '')
          .replace(/\s+/gu, ' ');
        for (const paragraph of input.paragraphs) {
          expect(canonicalTechnicalText).toContain(paragraph.textPreview);
        }
        expect(technicalText).toContain('METADATA');
        expect(technicalText).toContain('REFERENCE_SECTION');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    expect(tested.documents.read).toHaveBeenCalledTimes(1);
    expect(reviews[0]).not.toEqual(technicals[0]);
    expect(JSON.stringify(input)).toBe(snapshot);
  }, 30_000);
});
