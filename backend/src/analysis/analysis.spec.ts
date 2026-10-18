import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { AnalysisRunStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyzerUnavailableException, type AiService } from '../ai/ai.service.js';
import type { ModelVersionService } from '../datasets/model-version.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AnalysisService, driftStats, sha256 } from './analysis.service.js';
import { AnalyzerModelsService } from './models.service.js';

const DOC = '7d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const RUN = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const SECRET_TEXT = 'Párrafo sintético uno con contenido privado de prueba.\n\nPárrafo sintético dos con más texto.';

function aiResult() {
  return {
    analyzer: 'V3_ONLY', model: 'CANDIDATE_MODEL_V3', modelVersion: 'TURNITING_RESEARCH_V3_SPANISH_ACADEMIC',
    paragraphMode: 'CONTEXTUAL_PARAGRAPH', thresholdProfile: 'LOW_FALSE_POSITIVE', threshold: 0.9,
    thresholdSource: 'f005-test', calibration: 'isotonic', documentAggregation: 'token_weighted_mean',
    documentScore: 0.42, documentClassification: 'LOW_SIGNAL', documentSignalLevel: 'MODERATE', scoredParagraphs: 1,
    insufficientParagraphs: 1, preprocessingVersion: 'V3_CANONICALIZED_V1', inferenceMs: 12,
    segments: [
      { paragraphIndex: 0, charStart: 0, charEnd: 55, pageNumber: null, textHash: 'a'.repeat(64), words: 8, tokens: 14,
        rawScore: 0.5, calibratedScore: 0.42, classification: 'LOW_SIGNAL', signalLevel: 'MODERATE', confidence: 'LOW' },
      { paragraphIndex: 1, charStart: 57, charEnd: 93, pageNumber: null, textHash: 'b'.repeat(64), words: 6, tokens: 9,
        rawScore: null, calibratedScore: null, classification: 'INSUFFICIENT_TEXT', signalLevel: null, confidence: null },
    ],
  };
}

function makePrisma() {
  const prisma = {
    document: { findUnique: vi.fn() },
    analysisRun: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    analysisModelResult: { create: vi.fn() },
    analysisSegment: { createMany: vi.fn() },
    analysisComparison: { create: vi.fn() },
    modelVersion: { findUnique: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  };
  return prisma;
}

describe('AnalysisService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let ai: { analyzeParagraphs: ReturnType<typeof vi.fn>; alignVersions: ReturnType<typeof vi.fn> };
  let service: AnalysisService;

  beforeEach(() => {
    prisma = makePrisma();
    ai = { analyzeParagraphs: vi.fn(), alignVersions: vi.fn() };
    service = new AnalysisService(prisma as unknown as PrismaService, ai as unknown as AiService);
    prisma.document.findUnique.mockResolvedValue({ id: DOC, currentVersion: { id: 'v1', extractedText: SECRET_TEXT } });
    prisma.analysisRun.create.mockResolvedValue({ id: RUN });
    prisma.analysisRun.findUnique.mockResolvedValue({ id: RUN, status: 'COMPLETED', modelResults: [],
      documentVersion: { documentId: DOC } });
    prisma.modelVersion.findUnique.mockResolvedValue({ id: 'mv3' });
  });

  it('stores scores and offsets only (no text) and never logs document content', async () => {
    ai.analyzeParagraphs.mockResolvedValue(aiResult());
    const logs: string[] = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); });
    const out = await service.analyzeDocument(DOC, { analyzer: 'V3_ONLY', thresholdProfile: 'LOW_FALSE_POSITIVE',
      granularity: 'PARAGRAPH', paragraphMode: 'CONTEXTUAL_PARAGRAPH' });
    expect(out.disclaimer).toMatch(/not a Turnitin score/);
    const segments = prisma.analysisSegment.createMany.mock.calls[0][0].data;
    expect(segments).toHaveLength(2);
    expect(JSON.stringify(segments)).not.toContain('sintético');
    expect(segments[1].classification).toBe('INSUFFICIENT_TEXT');
    expect(prisma.analysisRun.create.mock.calls[0][0].data.textHash).toBe(sha256(SECRET_TEXT));
    expect(logs.join(' ')).not.toContain('sintético');
    const completed = prisma.analysisRun.update.mock.calls.at(-1)[0].data;
    expect(completed.status).toBe(AnalysisRunStatus.COMPLETED);
  });

  it('marks the run FAILED and surfaces MODEL_UNAVAILABLE when weights are missing', async () => {
    ai.analyzeParagraphs.mockRejectedValue(new AnalyzerUnavailableException('MODEL_UNAVAILABLE'));
    await expect(service.analyzeDocument(DOC, { analyzer: 'V2_ONLY', thresholdProfile: 'BALANCED',
      granularity: 'PARAGRAPH', paragraphMode: 'STRICT_PARAGRAPH' })).rejects.toBeInstanceOf(AnalyzerUnavailableException);
    const failed = prisma.analysisRun.update.mock.calls.at(-1)[0].data;
    expect(failed.status).toBe(AnalysisRunStatus.FAILED);
    expect(failed.errorCode).toBe('MODEL_UNAVAILABLE');
  });

  it('rejects documents without text, unknown documents and CUSTOM without a threshold', async () => {
    prisma.document.findUnique.mockResolvedValueOnce({ id: DOC, currentVersion: { id: 'v1', extractedText: '  ' } });
    const dto = { analyzer: 'V3_ONLY' as const, thresholdProfile: 'BALANCED' as const, granularity: 'PARAGRAPH' as const,
      paragraphMode: 'CONTEXTUAL_PARAGRAPH' as const };
    await expect(service.analyzeDocument(DOC, dto)).rejects.toBeInstanceOf(ConflictException);
    prisma.document.findUnique.mockResolvedValueOnce(null);
    await expect(service.analyzeDocument(DOC, dto)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.analyzeDocument(DOC, { ...dto, thresholdProfile: 'CUSTOM' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('materializes segment text from the extracted text and flags stale analyses', async () => {
    const seg = { paragraphIndex: 0, charStart: 0, charEnd: 9, calibratedScore: 0.2 };
    prisma.analysisRun.findUnique.mockResolvedValueOnce({ id: RUN, textHash: sha256(SECRET_TEXT), segments: [seg],
      documentVersion: { extractedText: SECRET_TEXT } });
    expect((await service.getSegments(RUN)).items[0].text).toBe('Párrafo s');
    prisma.analysisRun.findUnique.mockResolvedValueOnce({ id: RUN, textHash: 'x'.repeat(64), segments: [seg],
      documentVersion: { extractedText: SECRET_TEXT } });
    const stale = await service.getSegments(RUN);
    expect(stale.stale).toBe(true);
    expect(stale.items[0].text).toBeNull();
  });

  it('compares two analyses paragraph by paragraph', async () => {
    const run = (id: string, scores: number[], doc: number) => ({
      id, status: 'COMPLETED', analyzerMode: 'V3_ONLY', thresholdProfile: 'BALANCED', documentScore: doc,
      documentVersion: { extractedText: 'x' },
      segments: scores.map((s, i) => ({ paragraphIndex: i, calibratedScore: s, classification: 'LOW_SIGNAL' })),
    });
    prisma.analysisRun.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(where.id === 'a' ? run('a', [0.71, 0.18], 0.31) : run('b', [0.34, 0.17, 0.5], 0.24)));
    ai.alignVersions.mockResolvedValue({ documentSimilarity: 0.8, base: [], target: [], alignment: [
      { status: 'MODIFIED', baseParagraphIndex: 0, targetParagraphIndex: 0, similarity: 0.7, match: 'similarity' },
      { status: 'UNCHANGED', baseParagraphIndex: 1, targetParagraphIndex: 1, similarity: 1, match: 'exact_hash' },
      { status: 'ADDED', baseParagraphIndex: null, targetParagraphIndex: 2, similarity: 0, match: 'none' },
    ] });
    prisma.analysisComparison.create.mockImplementation(({ data }: { data: object }) => Promise.resolve({ id: 'c', ...data }));
    const out = await service.compare({ baseAnalysisId: 'a', targetAnalysisId: 'b' });
    expect(out.changedSegments).toBe(1);
    expect(out.addedSegments).toBe(1);
    expect(out.globalScoreDelta).toBeCloseTo(-0.07);
    expect(out.details.unchangedDrift?.max).toBeCloseTo(0.01);
    expect(out.details.paragraphs[0].delta).toBeCloseTo(-0.37);
  });

  it('refuses to compare analyses made with different profiles', async () => {
    prisma.analysisRun.findUnique.mockImplementation(({ where }: { where: { id: string } }) => Promise.resolve({
      id: where.id, status: 'COMPLETED', analyzerMode: 'V3_ONLY', segments: [], documentVersion: { extractedText: '' },
      thresholdProfile: where.id === 'a' ? 'BALANCED' : 'LOW_FALSE_POSITIVE' }));
    await expect(service.compare({ baseAnalysisId: 'a', targetAnalysisId: 'b' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('computes drift statistics', () => {
    expect(driftStats([])).toBeNull();
    const s = driftStats([0, 0.1, 0.2, 0.3]);
    expect(s?.median).toBeCloseTo(0.15);
    expect(s?.p95).toBeCloseTo(0.3);
  });
});

describe('AnalyzerModelsService', () => {
  it('merges registry metadata with live availability without exposing storage paths', async () => {
    const prisma = makePrisma();
    prisma.modelVersion.findMany.mockResolvedValue([{ id: 'mv2', name: 'CANDIDATE_MODEL_V2', status: 'CANDIDATE',
      architecture: 'microsoft/mdeberta-v3-base', variant: 'X', artifactProvider: 'GOOGLE_DRIVE',
      artifactPath: 'MyDrive/turniting/secret/path', limitations: ['lim'] }]);
    const ai = { listAnalyzerModels: vi.fn().mockResolvedValue({ models: [
      { model: 'CANDIDATE_MODEL_V3', state: 'UNAVAILABLE', status: 'CANDIDATE', servable: true, warnings: ['fpr'],
        thresholdProfiles: [], preprocessing: ['V3_CANONICALIZED_V1'] }] }) };
    const svc = new AnalyzerModelsService(prisma as unknown as PrismaService, ai as unknown as AiService,
      {} as ModelVersionService);
    const out = await svc.list();
    expect(out.items.find((m) => m.name === 'CANDIDATE_MODEL_V3')?.availability).toBe('UNAVAILABLE');
    expect(out.items.find((m) => m.name === 'CANDIDATE_MODEL_V2')?.registeredInDatabase).toBe(true);
    expect(out.activeModel).toBe('NONE');
    expect(out.recommendedExperimentalAnalyzer).toBe('ENSEMBLE_V2_V3');
    const f006 = out.items.find((m) => m.name === 'EXPERIMENTAL_F006_MODEL');
    expect(f006).toMatchObject({
      registeredInRegistry: true,
      status: 'EXPERIMENTAL',
      availability: 'UNAVAILABLE',
      artifactPresent: false,
      servable: false,
      promotionEligible: false,
      metrics: { evaluationSet: 'F006_FINAL_HOLDOUT', spanishHumanFpr: 0.1423 },
      activeGateResults: { spanishHumanFpr: { observed: 0.1423, limit: 0.08, passed: false } },
    });
    expect(f006?.warnings).toContain('Spanish human false-positive rate is elevated.');
    expect(f006?.officialGateResults?.D_spanish_strong).toBe(false);
    expect(JSON.stringify(out)).not.toContain('MyDrive');
    ai.listAnalyzerModels.mockRejectedValueOnce(new Error('down'));
    const down = await svc.list();
    expect(down.aiServiceReachable).toBe(false);
    expect(down.items[0].availability).toBe('AI_SERVICE_UNREACHABLE');
  });
});

describe('CANDIDATE_MODEL_V3 registry', () => {
  it('is a valid model registry that never activates the model and carries the FPR warning', async () => {
    const { readFileSync } = await import('node:fs');
    const { validateModelRegistry } = await import('../datasets/manifest-schemas.js');
    const raw = JSON.parse(readFileSync(new URL('../../../training/datasets/manifests/model_registry_v3.json', import.meta.url), 'utf8'));
    const registry = validateModelRegistry(raw);
    expect(registry.datasetVersion).toBe('TURNITING_DATASET_V2');
    expect(registry.models[0].status).toBe('CANDIDATE');
    expect(JSON.stringify(registry.models[0].metadata)).toContain('FROZEN_V1_FPR_REGRESSION');
  });
});
