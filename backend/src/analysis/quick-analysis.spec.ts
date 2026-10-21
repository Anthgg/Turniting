import { BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { validateSync } from 'class-validator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiAnalyzerSegment, AiParagraphAnalysis, AiService } from '../ai/ai.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AnalysisService } from './analysis.service.js';
import { QUICK_ANALYSIS_MAX_CHARS, QuickAnalysisDto } from './dto/quick-analysis.dto.js';

const PRIVATE_SYNTHETIC_TEXT = 'Synthetic private paragraph text that must not be returned.';

afterEach(() => vi.restoreAllMocks());

function makeSegment(
  paragraphIndex: number,
  classification: AiAnalyzerSegment['classification'],
  calibratedScore: number | null,
): AiAnalyzerSegment {
  return {
    paragraphIndex,
    charStart: paragraphIndex * 10,
    charEnd: paragraphIndex * 10 + 9,
    pageNumber: null,
    textHash: `private-hash-${paragraphIndex}`,
    words: 30,
    tokens: 40,
    rawScore: calibratedScore,
    calibratedScore,
    classification,
    signalLevel: calibratedScore === null ? null : 'MODERATE',
    confidence: calibratedScore === null ? null : 'MEDIUM',
  };
}

function makeResult(segments: AiAnalyzerSegment[], model = 'CANDIDATE_MODEL_V3'): AiParagraphAnalysis {
  const scoredParagraphs = segments.filter((segment) => segment.classification !== 'INSUFFICIENT_TEXT').length;
  return {
    analyzer: model === 'ENSEMBLE_V2_V3' ? 'ENSEMBLE' : 'V3_ONLY',
    model,
    modelVersion: 'synthetic-model-version',
    paragraphMode: 'STRICT_PARAGRAPH',
    thresholdProfile: 'BALANCED',
    threshold: 0.6,
    thresholdSource: 'synthetic-thresholds.json',
    calibration: 'synthetic-calibration',
    documentAggregation: 'token_weighted_mean',
    documentScore: null,
    rawDocumentScore: null,
    documentClassification: null,
    documentSignalLevel: null,
    scoredParagraphs,
    insufficientParagraphs: segments.length - scoredParagraphs,
    segments,
    preprocessingVersion: 'synthetic-preprocessing',
    inferenceMs: 7,
  };
}

function makePrisma() {
  return {
    document: { findUnique: vi.fn() },
    analysisRun: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    analysisModelResult: { create: vi.fn() },
    analysisSegment: { createMany: vi.fn() },
    analysisComparison: { create: vi.fn() },
    modelVersion: { findUnique: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  };
}

function makeService(resolvedModel: string | null, result: AiParagraphAnalysis) {
  const prisma = makePrisma();
  const ai = {
    listAnalyzerModels: vi.fn().mockResolvedValue({
      models: [],
      policy: { resolvedLocalPreferredAnalyzer: resolvedModel },
    }),
    analyzeParagraphs: vi.fn().mockResolvedValue(result),
  };
  return {
    prisma,
    ai,
    service: new AnalysisService(prisma as unknown as PrismaService, ai as unknown as AiService),
  };
}

describe('AnalysisService.quickAnalyze', () => {
  it('uses the preferred local model and returns only non-identifying paragraph results', async () => {
    const result = makeResult([
      makeSegment(0, 'LOW_SIGNAL', 0.2),
      makeSegment(1, 'MACHINE_SIGNAL', 0.8),
      makeSegment(2, 'INSUFFICIENT_TEXT', null),
    ]);
    result.documentScore = 0.314159;
    result.documentClassification = 'LOW_SIGNAL';
    const { ai, prisma, service } = makeService('CANDIDATE_MODEL_V3', result);
    const logs: string[] = [];
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => { logs.push(String(message)); });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => { logs.push(String(message)); });

    const response = await service.quickAnalyze({ text: PRIVATE_SYNTHETIC_TEXT });

    expect(ai.analyzeParagraphs).toHaveBeenCalledWith({
      text: PRIVATE_SYNTHETIC_TEXT,
      analyzer: 'V3_ONLY',
      thresholdProfile: 'BALANCED',
      paragraphMode: 'STRICT_PARAGRAPH',
      languageCode: 'other',
    });
    expect(response).toMatchObject({
      evaluated: true,
      score: 0.314159,
      scientificFlag: 'LOW_SIGNAL',
      reviewHighlighted: true,
      scoredParagraphs: 2,
      insufficientParagraphs: 1,
      scientificThreshold: 0.6,
      reviewThreshold: 0.2,
      model: {
        id: 'CANDIDATE_MODEL_V3',
        displayName: 'Candidate Model V3',
        version: 'synthetic-model-version',
      },
      languageCode: 'other',
      paragraphs: [
        { index: 0, status: 'LOW_SIGNAL', score: 0.2, scientificFlag: false, reviewHighlighted: false },
        { index: 1, status: 'MACHINE_SIGNAL', score: 0.8, scientificFlag: true, reviewHighlighted: true },
        { index: 2, status: 'INSUFFICIENT_TEXT', score: null, scientificFlag: null, reviewHighlighted: false },
      ],
    });
    expect(response.latencyMs).toBeGreaterThanOrEqual(0);

    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain(PRIVATE_SYNTHETIC_TEXT);
    expect(serialized).not.toContain('private-hash');
    expect(serialized).not.toContain('charStart');
    expect(serialized).not.toContain('charEnd');
    expect(response).not.toHaveProperty('documentScore');
    expect(log.mock.calls.flat().join(' ')).not.toContain(PRIVATE_SYNTHETIC_TEXT);
    expect(warn.mock.calls.flat().join(' ')).not.toContain(PRIVATE_SYNTHETIC_TEXT);
    expect(logs.join(' ')).not.toContain(PRIVATE_SYNTHETIC_TEXT);

    for (const operation of [
      ...Object.values(prisma.document),
      ...Object.values(prisma.analysisRun),
      ...Object.values(prisma.analysisModelResult),
      ...Object.values(prisma.analysisSegment),
      ...Object.values(prisma.analysisComparison),
      ...Object.values(prisma.modelVersion),
      prisma.$transaction,
    ]) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it('maps the resolved ensemble preference and keeps all-insufficient input unevaluated', async () => {
    const result = makeResult([makeSegment(0, 'INSUFFICIENT_TEXT', null)], 'ENSEMBLE_V2_V3');
    result.documentClassification = 'INSUFFICIENT_TEXT';
    const { ai, service } = makeService('ENSEMBLE_V2_V3', result);

    const response = await service.quickAnalyze({ text: PRIVATE_SYNTHETIC_TEXT, languageCode: 'es' });

    expect(ai.analyzeParagraphs).toHaveBeenCalledWith(expect.objectContaining({
      analyzer: 'ENSEMBLE',
      languageCode: 'es',
    }));
    expect(response).toMatchObject({
      evaluated: false,
      score: null,
      scientificFlag: 'INSUFFICIENT_TEXT',
      reviewHighlighted: false,
      scoredParagraphs: 0,
      insufficientParagraphs: 1,
      languageCode: 'es',
      paragraphs: [{ index: 0, status: 'INSUFFICIENT_TEXT', score: null, scientificFlag: null, reviewHighlighted: false }],
    });
  });

  it.each([
    { score: 0.2, highlighted: false },
    { score: 0.2001, highlighted: true },
  ])('uses the existing aggregate score for the strict global review boundary ($score)', async ({ score, highlighted }) => {
    const result = makeResult([makeSegment(0, 'LOW_SIGNAL', 0.99)]);
    result.documentScore = score;
    result.documentClassification = 'LOW_SIGNAL';
    const { service } = makeService('CANDIDATE_MODEL_V3', result);

    const response = await service.quickAnalyze({ text: PRIVATE_SYNTHETIC_TEXT });

    expect(response).toMatchObject({
      evaluated: true,
      score,
      scientificFlag: 'LOW_SIGNAL',
      reviewHighlighted: highlighted,
      paragraphs: [{ score: 0.99 }],
    });
  });

  it('rejects blank text without calling the model service', async () => {
    const { ai, service } = makeService('CANDIDATE_MODEL_V3', makeResult([]));

    await expect(service.quickAnalyze({ text: '  \n  ' })).rejects.toBeInstanceOf(BadRequestException);
    expect(ai.listAnalyzerModels).not.toHaveBeenCalled();
    expect(ai.analyzeParagraphs).not.toHaveBeenCalled();
  });

  it('fails closed when the preferred analyzer cannot be resolved', async () => {
    const { ai, service } = makeService(null, makeResult([]));

    await expect(service.quickAnalyze({ text: PRIVATE_SYNTHETIC_TEXT }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(ai.analyzeParagraphs).not.toHaveBeenCalled();
  });

  it('limits request text to the quick-analysis size cap', () => {
    const tooLong = Object.assign(new QuickAnalysisDto(), { text: 'x'.repeat(QUICK_ANALYSIS_MAX_CHARS + 1) });
    const atLimit = Object.assign(new QuickAnalysisDto(), { text: 'x'.repeat(QUICK_ANALYSIS_MAX_CHARS) });

    expect(validateSync(tooLong).some((error) => error.property === 'text')).toBe(true);
    expect(validateSync(atLimit)).toHaveLength(0);
  });
});
