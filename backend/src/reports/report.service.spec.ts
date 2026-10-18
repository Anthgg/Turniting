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
      findUnique: vi.fn(async ({ where }: any) => ({ id: where.id })),
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
      findMany: vi.fn(async ({ where }: any = {}) => {
        if (where?.expiresAt?.lte)
          return rows.filter(
            (row) =>
              row.expiresAt <= where.expiresAt.lte && row.deletedAt === null,
          );
        if (where?.status === ReportArtifactStatus.GENERATING)
          return rows.filter(
            (row) =>
              row.status === ReportArtifactStatus.GENERATING &&
              row.createdAt <= where.createdAt.lte &&
              row.deletedAt === null,
          );
        if (where?.documentId)
          return rows.filter((row) => row.documentId === where.documentId);
        return rows;
      }),
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
    expect(h.audits).toContainEqual({
      reportArtifactId: metadata.id,
      type: ReportAuditEventType.REPORT_GENERATED,
    });
    expect('storageKey' in metadata).toBe(false);
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
    expect(h.renderer.renderAI).not.toHaveBeenCalled();
    expect(h.prisma.reportArtifact.create).not.toHaveBeenCalled();
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

    expect(artifact.status).toBe(ReportArtifactStatus.DELETED);
    expect(artifact.deletedAt).toBeInstanceOf(Date);
    expect(h.storage.delete).toHaveBeenCalledWith(artifact.storageKey);
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

    expect(await h.service.cleanupExpired(now)).toBe(1);
    expect(await h.service.cleanupExpired(now)).toBe(0);
    expect(artifact.status).toBe(ReportArtifactStatus.EXPIRED);
    expect(artifact.analysisRunId).toBe(RUN_ID);
    expect(h.storage.delete).toHaveBeenCalledOnce();
    expect(h.prisma.analysisRun).not.toHaveProperty('delete');
  });

  it('marks an abandoned generation as an error instead of leaving it generating forever', async () => {
    const artifact = makeArtifact({
      status: ReportArtifactStatus.GENERATING,
      generatedAt: new Date(Date.now() - 20 * 60 * 1000),
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
      expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
    });
    h.rows.push(artifact);
    h.storage.delete.mockResolvedValueOnce(false);

    await h.service.cleanupExpired(new Date());

    expect(artifact.status).toBe(ReportArtifactStatus.ERROR);
    expect(artifact.activeFingerprint).toBeNull();
    expect(artifact.deletedAt).toBeNull();
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
