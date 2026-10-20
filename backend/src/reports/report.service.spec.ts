import { ConfigService } from '@nestjs/config';
import {
  ReportArtifactStatus,
  ReportAuditEventType,
  ReportType,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ReportRenderer } from './report-renderer.js';
import type { AIReportInput } from './report.contracts.js';
import { ReportService } from './report.service.js';
import type { OriginalDocumentRenderer } from './original-document-renderer.js';
import type { ReportStorageAdapter } from './report-storage.js';

// Unit tests isolate storage/lifecycle orchestration; real PDF metadata is verified by renderer integration tests.
vi.mock('./report-pdf-metadata.js', () => ({ stampTurnitingReport: vi.fn(async (buffer: Buffer) => buffer) }));

const DOCUMENT_ID = '66b2f3c5-14df-4156-a1df-152a7129f88e';
const VERSION_ID = '8edee971-57eb-478b-b811-5f83b8115ea3';
const RUN_ID = '31ec6f6f-4be4-49da-9bf5-ccf9fe77aab4';
const PDF = Buffer.from('%PDF-1.7 synthetic report bytes');
const SOURCE = Buffer.from('synthetic source document bytes');
const TEXT =
  'Primer párrafo sintético con evidencia local.\n\nSegundo párrafo de prueba.';

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function syntheticRun(documentId = DOCUMENT_ID) {
  return {
    id: RUN_ID,
    documentVersionId: VERSION_ID,
    sourceDocumentId: documentId,
    sourceDocumentVersionId: VERSION_ID,
    status: 'COMPLETED',
    analyzerMode: 'V3_ONLY',
    analyzerVersion: 'f005-test',
    thresholdProfile: 'BALANCED',
    threshold: 0.58,
    paragraphMode: 'STRICT_PARAGRAPH',
    documentAggregation: 'token_weighted_mean',
    documentScore: 0.42,
    signalLevel: 'MODERATE',
    scoredSegments: 1,
    insufficientSegments: 1,
    inferenceMs: 12,
    textHash: sha256(TEXT),
    metadata: { cacheHit: false },
    createdAt: new Date('2026-10-18T12:00:00.000Z'),
    completedAt: new Date('2026-10-18T12:00:00.012Z'),
    documentVersion: {
      id: VERSION_ID,
      documentId,
      originalFilename: 'muestra_sintetica.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extractedText: TEXT,
      fileHash: sha256(SOURCE),
      storageKey: 'synthetic/source.docx',
      document: {
        id: documentId,
        originalName: 'muestra_sintetica.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        createdAt: new Date('2026-10-17T10:00:00.000Z'),
        updatedAt: new Date('2026-10-18T11:00:00.000Z'),
      },
    },
    segments: [
      {
        paragraphIndex: 0,
        charStart: 0,
        charEnd: TEXT.indexOf('\n'),
        pageNumber: 1,
        words: 6,
        tokens: 8,
        calibratedScore: 0.42,
        signalLevel: 'MODERATE',
        classification: 'LOW_SIGNAL',
        textHash: sha256(TEXT.slice(0, TEXT.indexOf('\n'))),
      },
      {
        paragraphIndex: 1,
        charStart: TEXT.lastIndexOf('Segundo'),
        charEnd: TEXT.length,
        pageNumber: 1,
        words: 5,
        tokens: 7,
        calibratedScore: null,
        signalLevel: null,
        classification: 'INSUFFICIENT_TEXT',
        textHash: sha256(TEXT.slice(TEXT.lastIndexOf('Segundo'))),
      },
    ],
    modelResults: [
      {
        modelName: 'CANDIDATE_MODEL_V3',
        modelVariant: 'synthetic-v3',
        modelVersion: {
          name: 'CANDIDATE_MODEL_V3',
          limitations: ['Limitación sintética del modelo de prueba.'],
        },
      },
    ],
  };
}

function makeArtifact(overrides: Record<string, unknown> = {}) {
  const generatedAt = new Date();
  return {
    id: 'e564fa70-4188-4e8e-a4eb-98fda94f8865',
    documentId: DOCUMENT_ID,
    documentVersionId: VERSION_ID,
    analysisRunId: RUN_ID,
    sourceDocumentId: DOCUMENT_ID,
    sourceDocumentVersionId: VERSION_ID,
    sourceChecksum: sha256(SOURCE),
    generatedBy: 'TURNITING',
    similarityRunId: null,
    type: ReportType.AI_REPORT,
    status: ReportArtifactStatus.AVAILABLE,
    filename: 'turniting_ai_66b2f3c5_2026-10-18.pdf',
    storageKey: 'e564fa70-4188-4e8e-a4eb-98fda94f8865.pdf',
    fingerprint: 'a'.repeat(64),
    activeFingerprint: 'a'.repeat(64),
    contentHash: 'b'.repeat(64),
    sizeBytes: PDF.length,
    failureReason: null,
    generatedAt,
    expiresAt: new Date(generatedAt.getTime() + 24 * 60 * 60 * 1000),
    deletedAt: null,
    generationVersion: 'f009-report-renderer-v1',
    createdAt: generatedAt,
    updatedAt: generatedAt,
    ...overrides,
  };
}

function makeHarness() {
  const rows: Array<Record<string, any>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const prisma = {
    document: {
      findUnique: vi.fn(async ({ where }: any) => ({
        id: where.id,
        originalName: 'muestra_sintetica.docx',
      })),
    },
    analysisRun: {
      findUnique: vi.fn(async () => syntheticRun()),
      findMany: vi.fn(async () => []),
    },
    reportArtifact: {
      findUnique: vi.fn(
        async ({ where }: any) =>
          rows.find((row) => row.id === where.id) ?? null,
      ),
      findFirst: vi.fn(
        async ({ where }: any) =>
          rows.find(
            (row) => row.activeFingerprint === where.activeFingerprint,
          ) ?? null,
      ),
      findMany: vi.fn(async ({ where, skip = 0, take }: any = {}) => {
        let result = rows.filter((row) => {
          if (where?.expiresAt?.lte && row.expiresAt > where.expiresAt.lte)
            return false;
          if (where?.createdAt?.lte && row.createdAt > where.createdAt.lte)
            return false;
          if (where?.deletedAt === null && row.deletedAt !== null) return false;
          if (where?.status && row.status !== where.status) return false;
          if (where?.type && row.type !== where.type) return false;
          if (where?.documentId && row.documentId !== where.documentId)
            return false;
          return true;
        });
        result = [...result].sort(
          (left, right) =>
            right.generatedAt.getTime() - left.generatedAt.getTime(),
        );
        return take === undefined ? result : result.slice(skip, skip + take);
      }),
      count: vi.fn(async ({ where }: any = {}) =>
        rows.filter((row) => {
          if (where?.documentId && row.documentId !== where.documentId)
            return false;
          if (where?.type && row.type !== where.type) return false;
          if (where?.status && row.status !== where.status) return false;
          return true;
        }).length,
      ),
      create: vi.fn(async ({ data }: any) => {
        const row = {
          ...data,
          contentHash: null,
          sizeBytes: null,
          failureReason: null,
          deletedAt: null,
          createdAt: data.generatedAt,
          updatedAt: data.generatedAt,
        };
        rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = rows.find((item) => item.id === where.id);
        if (!row) throw new Error('Missing fixture report');
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = rows.find((item) => item.id === where.id);
        if (
          !row ||
          (where.deletedAt === null && row.deletedAt !== null) ||
          (where.status && row.status !== where.status) ||
          (where.activeFingerprint &&
            row.activeFingerprint !== where.activeFingerprint) ||
          (where.expiresAt?.lte && row.expiresAt > where.expiresAt.lte)
        )
          return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    reportAuditEvent: {
      create: vi.fn(async ({ data }: any) => {
        audits.push(data);
        return data;
      }),
    },
    originalRenderArtifact: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    documentLayoutMap: {
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) =>
      callback(prisma),
    ),
  };
  const storage = {
    save: vi.fn(async () => undefined),
    read: vi.fn(async () => PDF),
    exists: vi.fn(async () => true),
    delete: vi.fn(async () => true),
  };
  const renderer = {
    renderAI: vi.fn(async () => PDF),
    renderAIParagraphTechnical: vi.fn(async (_input: AIReportInput) => PDF),
  };
  const originalRenderer = {
    ensure: vi.fn(async (_input: unknown) => ({
      artifact: {},
      buffer: SOURCE,
      layoutMap: { version: 'fixture', pages: [], segments: [] },
    })),
    renderOriginalReview: vi.fn(async () => PDF),
  };
  const config = { get: vi.fn(() => '24') };
  const service = new ReportService(
    prisma as unknown as PrismaService,
    renderer as unknown as ReportRenderer,
    storage as unknown as ReportStorageAdapter,
    config as unknown as ConfigService,
    originalRenderer as unknown as OriginalDocumentRenderer,
  );
  return { service, prisma, storage, renderer, originalRenderer, config, rows, audits };
}

async function waitForGeneration(row: Record<string, any>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (
    row.status === ReportArtifactStatus.GENERATING &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('ReportService', () => {
  let h: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    h = makeHarness();
  });

  it('requires an exact analysis ID before any lookup or rendering', async () => {
    await expect(h.service.generateBothAI(DOCUMENT_ID, '')).rejects.toMatchObject({ response: { code: 'ANALYSIS_RUN_REQUIRED' } });
    expect(h.prisma.analysisRun.findUnique).not.toHaveBeenCalled();
    expect(h.prisma.reportArtifact.create).not.toHaveBeenCalled();
  });

  it('resolves one run once for both reports and persists identical source, score, threshold and model snapshots', async () => {
    const pair = await h.service.generateBothAI(DOCUMENT_ID, RUN_ID);
    await Promise.all(h.rows.map(waitForGeneration));
    expect(h.prisma.analysisRun.findUnique).toHaveBeenCalledTimes(1);
    expect(pair.originalReview.id).not.toBe(pair.paragraphTechnical.id);
    expect(h.rows).toHaveLength(2);
    expect(h.rows[0].analysisSnapshot).toEqual(h.rows[1].analysisSnapshot);
    for (const row of h.rows) {
      expect(row).toMatchObject({ generatedBy: 'TURNITING', analysisRunId: RUN_ID, sourceDocumentId: DOCUMENT_ID, sourceDocumentVersionId: VERSION_ID, sourceChecksum: sha256(SOURCE), analysisSnapshot: { run: { id: RUN_ID, globalScore: .42, threshold: .58, modelNames: ['CANDIDATE_MODEL_V3'], segmentCount: 2 } } });
    }
    const tech = h.renderer.renderAIParagraphTechnical.mock.calls[0]![0];
    expect(tech.paragraphs).toHaveLength(syntheticRun().segments.length);
    expect(h.originalRenderer.ensure.mock.calls[0]![0]).toMatchObject({ sourceArtifactType: 'DOCUMENT_VERSION', documentVersionId: VERSION_ID, analysisRunId: RUN_ID });
    expect(h.prisma.analysisRun).not.toHaveProperty('create');
  });

  it('rejects a run whose immutable source binding disagrees with its version', async () => {
    const bad = syntheticRun();
    bad.sourceDocumentVersionId = 'ffffffff-0000-4000-8000-000000000001';
    h.prisma.analysisRun.findUnique.mockResolvedValueOnce(bad as never);
    await expect(h.service.generateBothAI(DOCUMENT_ID, RUN_ID)).rejects.toMatchObject({ response: { code: 'ANALYSIS_SOURCE_INTEGRITY_INVALID' } });
    expect(h.prisma.reportArtifact.create).not.toHaveBeenCalled();
  });

  it('uses the version source name rather than mutable document display metadata', async () => {
    const run = syntheticRun();
    run.documentVersion.document.originalName = 'turniting_paragraph-technical_other.pdf';
    h.prisma.analysisRun.findUnique.mockResolvedValueOnce(run as never);
    const pair = await h.service.generateBothAI(DOCUMENT_ID, RUN_ID);
    await Promise.all(h.rows.map(waitForGeneration));
    expect(pair.originalReview.filename).toContain('muestra_sintetica');
    expect(pair.paragraphTechnical.documentName).toBe('muestra_sintetica.docx');
    expect(h.renderer.renderAIParagraphTechnical.mock.calls[0]![0].document.filename).toBe('muestra_sintetica.docx');
  });

  it('regenerates each available variant from the same run without changing the other variant or source', async () => {
    const pair = await h.service.generateBothAI(DOCUMENT_ID, RUN_ID);
    await Promise.all(h.rows.map(waitForGeneration));
    const regeneratedA = await h.service.regenerate(pair.originalReview.id);
    await waitForGeneration(h.rows[2]);
    const regeneratedB = await h.service.regenerate(pair.paragraphTechnical.id);
    await waitForGeneration(h.rows[3]);
    expect(regeneratedA.id).not.toBe(pair.originalReview.id);
    expect(regeneratedB.id).not.toBe(pair.paragraphTechnical.id);
    expect(h.rows.map(row => row.analysisRunId)).toEqual([RUN_ID, RUN_ID, RUN_ID, RUN_ID]);
    expect(h.rows.map(row => row.analysisSnapshot)).toEqual(Array(4).fill(h.rows[0].analysisSnapshot));
    expect(h.rows.map(row => row.status)).toEqual(Array(4).fill(ReportArtifactStatus.AVAILABLE));
    await h.service.delete(regeneratedA.id);
    expect(h.rows[3].status).toBe(ReportArtifactStatus.AVAILABLE);
    await h.service.delete(regeneratedB.id);
    expect(h.rows[0].status).toBe(ReportArtifactStatus.AVAILABLE);
    expect(h.prisma.analysisRun).not.toHaveProperty('delete');
  });

  it('rejects regeneration if an artifact claims a different source version', async () => {
    const artifact = makeArtifact({ sourceDocumentVersionId: 'ffffffff-0000-4000-8000-000000000001' });
    h.rows.push(artifact);
    await expect(h.service.regenerate(artifact.id)).rejects.toMatchObject({ response: { code: 'ANALYSIS_SOURCE_INTEGRITY_INVALID' } });
    expect(h.prisma.reportArtifact.create).not.toHaveBeenCalled();
  });

  it('creates an AI artifact with exactly 24 hours of retention and renders from the completed run', async () => {
    const metadata = await h.service.generateAI(DOCUMENT_ID, RUN_ID);
    await waitForGeneration(h.rows);

    expect([
      ReportArtifactStatus.GENERATING,
      ReportArtifactStatus.AVAILABLE,
    ]).toContain(metadata.status);
    await waitForGeneration(h.rows[0]);
    expect(h.rows[0].status).toBe(ReportArtifactStatus.AVAILABLE);
    expect(
      h.rows[0].expiresAt.getTime() - h.rows[0].generatedAt.getTime(),
    ).toBe(24 * 60 * 60 * 1000);
    expect(h.renderer.renderAI).toHaveBeenCalledOnce();
    const input = h.renderer.renderAI.mock.calls[0]![0] as AIReportInput;
    expect(input.extractedText).toBe(TEXT);
    expect(input.paragraphs.map(({ charStart, charEnd }) => [charStart, charEnd])).toEqual([
      [0, TEXT.indexOf('\n')],
      [TEXT.lastIndexOf('Segundo'), TEXT.length],
    ]);
    expect(input.paragraphs[0]).toMatchObject({
      score: 0.42,
      signalLevel: 'MODERATE',
      reviewPresentation: { highlight: false, level: 'MODERATE' },
      reviewEvidence: { evaluated: true, flagged: false, threshold: 0.58, granularity: 'PARAGRAPH', spans: [] },
    });
    expect(input.paragraphs[1]).toMatchObject({
      classification: 'INSUFFICIENT_TEXT',
      reviewPresentation: { highlight: false, excludedReason: 'INSUFFICIENT_TEXT' },
    });
    expect(input.run.documentScore).toBe(0.42);
    expect(h.storage.save).toHaveBeenCalledWith(`${metadata.id}.pdf`, PDF);
    expect(h.rows[0].contentHash).toBe(sha256(PDF.toString()));
    expect(h.rows[0].sizeBytes).toBe(PDF.length);
    expect(h.audits).toContainEqual({
      reportArtifactId: metadata.id,
      type: ReportAuditEventType.REPORT_GENERATED,
    });
    expect('storageKey' in metadata).toBe(false);
    expect(metadata.sizeBytes).toBeNull();
  });

  it('creates independent original-review and paragraph-technical artifacts from the same persisted run', async () => {
    const original = await h.service.generateAI(
      DOCUMENT_ID,
      RUN_ID,
      undefined,
      ReportType.AI_ORIGINAL_REVIEW,
    );
    await waitForGeneration(h.rows[0]);
    const technical = await h.service.generateAI(
      DOCUMENT_ID,
      RUN_ID,
      undefined,
      ReportType.AI_PARAGRAPH_TECHNICAL,
    );
    await waitForGeneration(h.rows[1]);

    expect(h.rows).toHaveLength(2);
    expect(h.rows.map((row) => row.type)).toEqual([
      ReportType.AI_ORIGINAL_REVIEW,
      ReportType.AI_PARAGRAPH_TECHNICAL,
    ]);
    expect(original.id).not.toBe(technical.id);
    expect(original.rendererVersion).not.toBe(technical.rendererVersion);
    expect(h.originalRenderer.ensure).toHaveBeenCalledOnce();
    expect(h.originalRenderer.renderOriginalReview).toHaveBeenCalledOnce();
    expect(h.renderer.renderAIParagraphTechnical).toHaveBeenCalledOnce();
    expect(h.renderer.renderAI).not.toHaveBeenCalled();
    expect(h.originalRenderer.ensure.mock.calls[0]![0]).toMatchObject({
      sourceChecksum: sha256(SOURCE),
      storageKey: 'synthetic/source.docx',
      segments: [
        { paragraphIndex: 0, flagged: false },
        { paragraphIndex: 1, flagged: false, presentationExcluded: true },
      ],
    });
    const technicalInput = h.renderer.renderAIParagraphTechnical.mock.calls[0]![0] as AIReportInput;
    expect(technicalInput.run).toMatchObject({
      documentScore: 0.42,
      threshold: 0.58,
    });
    expect(h.rows.map((row) => row.analysisRunId)).toEqual([RUN_ID, RUN_ID]);
    expect(h.rows.map((row) => row.contentHash)).toEqual([
      sha256(PDF.toString()),
      sha256(PDF.toString()),
    ]);

    const originalArtifact = h.rows.find((row) => row.id === original.id)!;
    const technicalArtifact = h.rows.find((row) => row.id === technical.id)!;
    expect(originalArtifact).toBeDefined();
    expect(technicalArtifact).toBeDefined();
    await h.service.delete(originalArtifact.id);
    expect(originalArtifact.status).toBe(ReportArtifactStatus.DELETED);
    expect(technicalArtifact.status).toBe(ReportArtifactStatus.AVAILABLE);
    expect(h.storage.delete).toHaveBeenCalledWith(originalArtifact.storageKey);
    await expect(h.service.download(technical.id)).resolves.toMatchObject({
      buffer: PDF,
    });
  });

  it('rejects a completed run that belongs to another document', async () => {
    h.prisma.analysisRun.findUnique.mockResolvedValueOnce(
      syntheticRun('a010ee97-b606-4f5c-b054-b606310e1204') as never,
    );
    await expect(
      h.service.generateAI(DOCUMENT_ID, RUN_ID),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.prisma.reportArtifact.create).not.toHaveBeenCalled();
  });

  it('rejects invalid persisted review offsets before creating a PDF artifact', async () => {
    const invalid = syntheticRun();
    invalid.segments[0]!.textHash = '0'.repeat(64);
    h.prisma.analysisRun.findUnique.mockResolvedValueOnce(invalid as never);

    await expect(h.service.generateAI(DOCUMENT_ID, RUN_ID)).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'ANALYSIS_SEGMENT_TEXT_MISMATCH',
        message: 'El texto del análisis no coincide con los rangos guardados.',
      },
    });

    expect(h.prisma.reportArtifact.create).not.toHaveBeenCalled();
    expect(h.renderer.renderAI).not.toHaveBeenCalled();
    expect(h.storage.save).not.toHaveBeenCalled();
  });

  it('reuses a live artifact with the same active fingerprint', async () => {
    const existing = makeArtifact();
    h.prisma.reportArtifact.findFirst.mockResolvedValueOnce(existing as never);

    const result = await h.service.generateAI(DOCUMENT_ID, RUN_ID);

    expect(result.id).toBe(existing.id);
    expect(result.status).toBe(ReportArtifactStatus.AVAILABLE);
    expect(result.reused).toBe(true);
    expect(h.renderer.renderAI).not.toHaveBeenCalled();
    expect(h.prisma.reportArtifact.create).not.toHaveBeenCalled();
    expect(h.audits).toContainEqual({
      reportArtifactId: existing.id,
      type: ReportAuditEventType.REPORT_REUSED,
    });
  });

  it('regenerates an expired artifact as a new artifact and keeps the old metadata', async () => {
    const old = makeArtifact({
      generatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    h.rows.push(old);
    h.prisma.reportArtifact.findFirst.mockResolvedValueOnce(old as never);

    const result = await h.service.generateAI(DOCUMENT_ID, RUN_ID);
    await waitForGeneration(h.rows[1]);

    expect(h.rows).toHaveLength(2);
    expect(old.status).toBe(ReportArtifactStatus.EXPIRED);
    expect(old.deletedAt).toBeInstanceOf(Date);
    expect(result.id).not.toBe(old.id);
    expect(h.rows[1].generatedAt.getTime()).toBeGreaterThan(
      old.generatedAt.getTime(),
    );
    expect(
      h.rows[1].expiresAt.getTime() - h.rows[1].generatedAt.getTime(),
    ).toBe(24 * 60 * 60 * 1000);
  });

  it('downloads only a live available PDF and records the download', async () => {
    const artifact = makeArtifact();
    h.rows.push(artifact);

    const result = await h.service.download(artifact.id);

    expect(result.buffer).toEqual(PDF);
    expect(result.metadata.downloadEndpoint).toBe(
      `/api/reports/${artifact.id}/download`,
    );
    expect(h.audits).toContainEqual({
      reportArtifactId: artifact.id,
      type: ReportAuditEventType.REPORT_DOWNLOADED,
    });
  });

  it('previews an available report inline without recording a download event', async () => {
    const artifact = makeArtifact({ type: ReportType.AI_ORIGINAL_REVIEW });
    h.rows.push(artifact);

    const preview = await h.service.preview(artifact.id);

    expect(preview.buffer).toEqual(PDF);
    expect(preview.metadata.previewEndpoint).toBe(
      `/api/reports/${artifact.id}/preview`,
    );
    expect(preview.metadata.previewAvailable).toBe(true);
    expect(h.audits).not.toContainEqual({
      reportArtifactId: artifact.id,
      type: ReportAuditEventType.REPORT_DOWNLOADED,
    });
  });

  it('lists reports with bounded pagination and document, type, and status filters', async () => {
    const older = makeArtifact({
      id: '11111111-1111-4111-8111-111111111111',
      generatedAt: new Date('2026-10-16T12:00:00.000Z'),
    });
    const newer = makeArtifact({
      id: '22222222-2222-4222-8222-222222222222',
      generatedAt: new Date('2026-10-17T12:00:00.000Z'),
    });
    const otherStatus = makeArtifact({
      id: '33333333-3333-4333-8333-333333333333',
      status: ReportArtifactStatus.EXPIRED,
    });
    const otherDocument = makeArtifact({
      id: '44444444-4444-4444-8444-444444444444',
      documentId: 'a010ee97-b606-4f5c-b054-b606310e1204',
    });
    h.rows.push(older, newer, otherStatus, otherDocument);

    const result = await h.service.list({
      documentId: DOCUMENT_ID,
      type: ReportType.AI_REPORT,
      status: ReportArtifactStatus.AVAILABLE,
      page: 2,
      pageSize: 1,
    });

    expect(result.total).toBe(2);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(1);
    expect(result.items.map((item) => item.id)).toEqual([older.id]);
    expect(result.items[0].documentName).toBe(`Documento ${DOCUMENT_ID.slice(0, 8)}`);
    expect('storageKey' in result.items[0]).toBe(false);
    expect(await h.service.list({ page: 1, pageSize: 500 })).toMatchObject({
      page: 1,
      pageSize: 100,
    });
  });

  it('refreshes missing files in history and excludes them from available filters', async () => {
    const artifact = makeArtifact();
    h.rows.push(artifact);
    h.storage.exists.mockResolvedValue(false);

    const history = await h.service.list();

    expect(history.items[0]).toMatchObject({
      id: artifact.id,
      status: ReportArtifactStatus.FAILED,
      failureReason: 'No se pudo generar el PDF. Intenta de nuevo.',
    });
    expect(await h.service.list({ status: ReportArtifactStatus.AVAILABLE })).toMatchObject({
      items: [],
      total: 0,
    });
  });

  it('returns safe metadata detail for the source document and run', async () => {
    const artifact = makeArtifact();
    h.rows.push(artifact);

    const result = await h.service.get(artifact.id);

    expect(result.documentName).toBe('muestra_sintetica.docx');
    expect(result.run).toMatchObject({
      id: RUN_ID,
      analyzerMode: 'V3_ONLY',
      thresholdProfile: 'BALANCED',
      paragraphMode: 'STRICT_PARAGRAPH',
      globalScore: 0.42,
      modelNames: ['CANDIDATE_MODEL_V3'],
    });
    expect('storageKey' in result).toBe(false);
  });

  it('rejects downloads after expiration and lets cleanup mark the artifact expired', async () => {
    const artifact = makeArtifact({
      generatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    h.rows.push(artifact);

    await expect(h.service.download(artifact.id)).rejects.toMatchObject({
      status: 410,
    });

    expect(artifact.status).toBe(ReportArtifactStatus.EXPIRED);
    expect(h.storage.delete).toHaveBeenCalledWith(artifact.storageKey);
  });

  it('deletes the PDF artifact without deleting its source AnalysisRun', async () => {
    const artifact = makeArtifact();
    h.rows.push(artifact);

    await h.service.delete(artifact.id);
    await h.service.delete(artifact.id);

    expect(artifact.status).toBe(ReportArtifactStatus.DELETED);
    expect(artifact.deletedAt).toBeInstanceOf(Date);
    expect(h.storage.delete).toHaveBeenCalledWith(artifact.storageKey);
    expect(h.storage.delete).toHaveBeenCalledOnce();
    expect(h.prisma.analysisRun).not.toHaveProperty('delete');
    expect(h.audits).toContainEqual({
      reportArtifactId: artifact.id,
      type: ReportAuditEventType.REPORT_DELETED,
    });
  });

  it('cleans expired files idempotently while preserving the run association', async () => {
    const now = new Date('2026-10-18T12:00:00.000Z');
    const artifact = makeArtifact({
      generatedAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
      expiresAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
    });
    h.rows.push(artifact);
    h.storage.delete.mockResolvedValueOnce(false);

    expect(await h.service.cleanupExpired(now)).toEqual({
      expiredCount: 1,
      deletedFiles: 0,
      missingFiles: 1,
      failedDeletes: 0,
      renderArtifactsExpired: 0,
      layoutMapsExpired: 0,
    });
    expect(await h.service.cleanupExpired(now)).toEqual({
      expiredCount: 0,
      deletedFiles: 0,
      missingFiles: 0,
      failedDeletes: 0,
      renderArtifactsExpired: 0,
      layoutMapsExpired: 0,
    });
    expect(artifact.status).toBe(ReportArtifactStatus.EXPIRED);
    expect(artifact.analysisRunId).toBe(RUN_ID);
    expect(h.storage.delete).toHaveBeenCalledOnce();
    expect(h.prisma.analysisRun).not.toHaveProperty('delete');
  });

  it('expires original-render files and layout maps in the same hourly cleanup', async () => {
    const now = new Date('2026-10-18T12:00:00.000Z');
    h.prisma.originalRenderArtifact.findMany.mockResolvedValueOnce([
      { id: 'expired-render', storageKey: 'expired-render.pdf' },
    ] as never);
    h.prisma.originalRenderArtifact.updateMany.mockResolvedValueOnce({
      count: 1,
    } as never);
    h.prisma.documentLayoutMap.updateMany.mockResolvedValueOnce({
      count: 2,
    } as never);

    const metrics = await h.service.cleanupExpired(now);

    expect(metrics).toEqual({
      expiredCount: 0,
      deletedFiles: 1,
      missingFiles: 0,
      failedDeletes: 0,
      renderArtifactsExpired: 1,
      layoutMapsExpired: 2,
    });
    expect(h.storage.delete).toHaveBeenCalledWith('expired-render.pdf');
    expect(h.prisma.originalRenderArtifact.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'expired-render' }),
        data: expect.objectContaining({ deletedAt: now, layoutPages: [] }),
      }),
    );
    expect(h.prisma.documentLayoutMap.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ expiresAt: { lte: now } }),
        data: expect.objectContaining({ deletedAt: now }),
      }),
    );
  });

  it('marks an abandoned generation as failed with a safe reason and audit event', async () => {
    const artifact = makeArtifact({
      status: ReportArtifactStatus.GENERATING,
      generatedAt: new Date(Date.now() - 20 * 60 * 1000),
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
      expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
    });
    h.rows.push(artifact);
    h.storage.delete.mockResolvedValueOnce(false);

    await h.service.cleanupExpired(new Date());

    expect(artifact.status).toBe(ReportArtifactStatus.FAILED);
    expect(artifact.activeFingerprint).toBeNull();
    expect(artifact.deletedAt).toBeNull();
    expect(artifact.failureReason).toBe('No se pudo generar el PDF. Intenta de nuevo.');
    expect(h.audits).toContainEqual({
      reportArtifactId: artifact.id,
      type: ReportAuditEventType.REPORT_FAILED,
    });
  });

  it('regenerates a failed or deleted AI report with a new identifier and audit trail', async () => {
    const old = makeArtifact({
      status: ReportArtifactStatus.DELETED,
      deletedAt: new Date(),
      activeFingerprint: null,
    });
    h.rows.push(old);

    const regenerated = await h.service.regenerate(old.id);
    await waitForGeneration(h.rows[1]);

    expect(h.rows).toHaveLength(2);
    expect(regenerated.id).not.toBe(old.id);
    expect(h.rows[0].id).toBe(old.id);
    expect(h.audits).toContainEqual({
      reportArtifactId: regenerated.id,
      type: ReportAuditEventType.REPORT_REGENERATED,
      metadata: { previousReportId: old.id },
    });
    expect(h.rows[1].sizeBytes).toBe(PDF.length);
  });

  it('regenerates a deleted original-review artifact as the same variant', async () => {
    const old = makeArtifact({
      type: ReportType.AI_ORIGINAL_REVIEW,
      status: ReportArtifactStatus.DELETED,
      deletedAt: new Date(),
      activeFingerprint: null,
    });
    h.rows.push(old);

    const regenerated = await h.service.regenerate(old.id);
    await waitForGeneration(h.rows[1]);

    expect(h.rows).toHaveLength(2);
    expect(regenerated.id).not.toBe(old.id);
    expect(h.rows[1].type).toBe(ReportType.AI_ORIGINAL_REVIEW);
    expect(h.originalRenderer.ensure).toHaveBeenCalledOnce();
    expect(h.renderer.renderAIParagraphTechnical).not.toHaveBeenCalled();
  });

  it('records a sanitized failure when PDF generation throws', async () => {
    h.renderer.renderAI.mockRejectedValueOnce(new Error('private source text must not be logged'));
    const report = await h.service.generateAI(DOCUMENT_ID, RUN_ID);
    await waitForGeneration(h.rows[0]);

    expect(h.rows[0].status).toBe(ReportArtifactStatus.FAILED);
    expect(h.rows[0].failureReason).toBe('No se pudo generar el PDF. Intenta de nuevo.');
    expect(h.audits).toContainEqual({
      reportArtifactId: report.id,
      type: ReportAuditEventType.REPORT_FAILED,
    });
  });

  it('reports failed file removals in cleanup metrics without changing artifact state', async () => {
    const artifact = makeArtifact({
      generatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    h.rows.push(artifact);
    h.storage.delete.mockRejectedValueOnce(new Error('synthetic filesystem failure'));

    const metrics = await h.service.cleanupExpired(new Date());

    expect(metrics).toEqual({
      expiredCount: 0,
      deletedFiles: 0,
      missingFiles: 0,
      failedDeletes: 1,
      renderArtifactsExpired: 0,
      layoutMapsExpired: 0,
    });
    expect(artifact.status).toBe(ReportArtifactStatus.AVAILABLE);
  });

  it('rejects similarity generation until a persisted F008 run is available', async () => {
    await expect(
      h.service.generateSimilarity(DOCUMENT_ID, RUN_ID),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'SIMILARITY_RUN_UNAVAILABLE',
        message:
          'El reporte de similitud estará disponible cuando exista un SimilarityRun persistido de F008.',
      },
    });
    expect(h.prisma.reportArtifact.create).not.toHaveBeenCalled();
  });
});
