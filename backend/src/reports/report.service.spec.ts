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
import { ReportService } from './report.service.js';
import type { ReportStorageAdapter } from './report-storage.js';

const DOCUMENT_ID = '66b2f3c5-14df-4156-a1df-152a7129f88e';
const VERSION_ID = '8edee971-57eb-478b-b811-5f83b8115ea3';
const RUN_ID = '31ec6f6f-4be4-49da-9bf5-ccf9fe77aab4';
const PDF = Buffer.from('%PDF-1.7 synthetic report bytes');
const TEXT =
  'Primer párrafo sintético con evidencia local.\n\nSegundo párrafo de prueba.';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function syntheticRun(documentId = DOCUMENT_ID) {
  return {
    id: RUN_ID,
    documentVersionId: VERSION_ID,
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
      extractedText: TEXT,
      document: {
        id: documentId,
        originalName: 'muestra_sintetica.docx',
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
  const renderer = { renderAI: vi.fn(async () => PDF) };
  const config = { get: vi.fn(() => '24') };
  const service = new ReportService(
    prisma as unknown as PrismaService,
    renderer as unknown as ReportRenderer,
    storage as unknown as ReportStorageAdapter,
    config as unknown as ConfigService,
  );
  return { service, prisma, storage, renderer, config, rows, audits };
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

  it('rejects a completed run that belongs to another document', async () => {
    h.prisma.analysisRun.findUnique.mockResolvedValueOnce(
      syntheticRun('a010ee97-b606-4f5c-b054-b606310e1204') as never,
    );
    await expect(
      h.service.generateAI(DOCUMENT_ID, RUN_ID),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.prisma.reportArtifact.create).not.toHaveBeenCalled();
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
    const artifact = makeArtifact({
      generatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    h.rows.push(artifact);
    h.storage.delete.mockResolvedValueOnce(false);
    const now = new Date('2026-10-18T12:00:00.000Z');

    expect(await h.service.cleanupExpired(now)).toEqual({
      expiredCount: 1,
      deletedFiles: 0,
      missingFiles: 1,
      failedDeletes: 0,
    });
    expect(await h.service.cleanupExpired(now)).toEqual({
      expiredCount: 0,
      deletedFiles: 0,
      missingFiles: 0,
      failedDeletes: 0,
    });
    expect(artifact.status).toBe(ReportArtifactStatus.EXPIRED);
    expect(artifact.analysisRunId).toBe(RUN_ID);
    expect(h.storage.delete).toHaveBeenCalledOnce();
    expect(h.prisma.analysisRun).not.toHaveProperty('delete');
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
