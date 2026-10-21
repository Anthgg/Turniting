import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { AnalysisRunStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyzerUnavailableException, type AiService } from '../ai/ai.service.js';
import type { ModelVersionService } from '../datasets/model-version.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AnalysisService, buildAnalysisCacheKey, displayPercent, driftStats, sha256 } from './analysis.service.js';
import { AnalyzerModelsService } from './models.service.js';

const DOC = '7d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const RUN = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const SECRET_TEXT = 'Párrafo sintético uno con contenido privado de prueba.\n\nPárrafo sintético dos con más texto.';

function aiResult() {
  const [firstParagraph, secondParagraph] = SECRET_TEXT.split('\n\n');
  return {
    analyzer: 'V3_ONLY', model: 'CANDIDATE_MODEL_V3', modelVersion: 'TURNITING_RESEARCH_V3_SPANISH_ACADEMIC',
    paragraphMode: 'CONTEXTUAL_PARAGRAPH', thresholdProfile: 'LOW_FALSE_POSITIVE', threshold: 0.9,
    thresholdSource: 'f005-test', calibration: 'isotonic', documentAggregation: 'token_weighted_mean',
    documentScore: 0.42, rawDocumentScore: 0.31, documentClassification: 'LOW_SIGNAL', documentSignalLevel: 'MODERATE', scoredParagraphs: 1,
    insufficientParagraphs: 1, preprocessingVersion: 'V3_CANONICALIZED_V1', inferenceMs: 12,
    contextMetadata: { tokenLimitPerSide: 64, measurement: 'tokens_per_window', preprocessingProfiles: ['V3_CANONICALIZED_V1'] },
    segments: [
      { paragraphIndex: 0, charStart: 0, charEnd: firstParagraph!.length, pageNumber: null,
        textHash: sha256(firstParagraph!), words: 8, tokens: 14,
        contextTokensUsed: { V3_CANONICALIZED_V1: { before: 0, after: 7 } },
        rawScore: 0.5, calibratedScore: 0.42, classification: 'LOW_SIGNAL', signalLevel: 'MODERATE', confidence: 'LOW' },
      { paragraphIndex: 1, charStart: firstParagraph!.length + 2, charEnd: SECRET_TEXT.length, pageNumber: null,
        textHash: sha256(secondParagraph!), words: 6, tokens: 9,
        contextTokensUsed: {}, rawScore: null, calibratedScore: null, classification: 'INSUFFICIENT_TEXT', signalLevel: null, confidence: null },
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
    ai = { analyzeParagraphs: vi.fn(), alignVersions: vi.fn(), listAnalyzerModels: vi.fn().mockResolvedValue({ models: [] }) };
    service = new AnalysisService(prisma as unknown as PrismaService, ai as unknown as AiService);
    prisma.document.findUnique.mockResolvedValue({ id: DOC, currentVersion: { id: 'v1', extractedText: SECRET_TEXT } });
    prisma.analysisRun.create.mockResolvedValue({ id: RUN });
    prisma.analysisRun.findUnique.mockResolvedValue({ id: RUN, status: 'COMPLETED', modelResults: [],
      documentVersion: { documentId: DOC } });
    prisma.analysisRun.findMany.mockResolvedValue([]);
    prisma.modelVersion.findUnique.mockResolvedValue({ id: 'mv3' });
  });

  it('separates analysis cache entries by model identity, calibration profile, paragraph mode, and text version', () => {
    const base = {
      modelId: 'CANDIDATE_MODEL_V3',
      modelVersion: 'v3-1',
      preprocessingVersion: 'V3_CANONICALIZED_V1',
      calibrationProfile: 'BALANCED',
      paragraphMode: 'STRICT_PARAGRAPH',
      textVersionHash: sha256('synthetic input'),
      granularity: 'PARAGRAPH',
      analyzerVersion: 'test',
    };
    const key = buildAnalysisCacheKey(base);
    expect(buildAnalysisCacheKey({ ...base, modelId: 'EXPERIMENTAL_F006_1_MODEL' })).not.toBe(key);
    expect(buildAnalysisCacheKey({ ...base, calibrationProfile: 'LOW_FALSE_POSITIVE' })).not.toBe(key);
    expect(buildAnalysisCacheKey({ ...base, calibrationProfile: 'BALANCED:es' })).not.toBe(
      buildAnalysisCacheKey({ ...base, calibrationProfile: 'BALANCED:en' }),
    );
    expect(buildAnalysisCacheKey({ ...base, paragraphMode: 'CONTEXTUAL_PARAGRAPH' })).not.toBe(key);
    expect(buildAnalysisCacheKey({ ...base, textVersionHash: sha256('different synthetic input') })).not.toBe(key);
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
    expect(completed.metadata).toMatchObject({ cacheHit: false });
    expect(completed.metadata.paragraphContext).toMatchObject({
      tokenLimitPerSide: 64,
      measurement: 'tokens_per_window',
      byParagraph: { '0': { V3_CANONICALIZED_V1: { before: 0, after: 7 } }, '1': {} },
    });
    expect(JSON.stringify(completed.metadata.paragraphContext)).not.toContain(SECRET_TEXT);
    expect(prisma.analysisModelResult.create.mock.calls[0][0].data).toMatchObject({
      modelName: 'CANDIDATE_MODEL_V3',
      rawScore: 0.31,
      calibratedScore: 0.42,
    });
    expect(completed.documentScore).toBe(prisma.analysisModelResult.create.mock.calls[0][0].data.calibratedScore);
  });

  it('passes explicit F006.1.1 language and persists the selected calibration source', async () => {
    ai.analyzeParagraphs.mockResolvedValueOnce({
      ...aiResult(),
      analyzer: 'F006_1_1_ONLY',
      model: 'EXPERIMENTAL_F006_1_1_MODEL',
      modelVersion: 'F006_1_1_C8_TOK06_ES_PLATT_EXPERIMENTAL',
      thresholdProfile: 'BALANCED',
      threshold: 0.767241379310345,
      calibration: 'ES_PLATT',
      calibrationSource: 'ES_PLATT',
      languageCode: 'es',
    });

    await service.analyzeDocument(DOC, {
      analyzer: 'F006_1_1_ONLY',
      languageCode: 'es',
      thresholdProfile: 'BALANCED',
      granularity: 'PARAGRAPH',
      paragraphMode: 'CONTEXTUAL_PARAGRAPH',
    });

    expect(ai.analyzeParagraphs).toHaveBeenCalledWith(expect.objectContaining({ languageCode: 'es' }));
    expect(prisma.analysisModelResult.create.mock.calls[0][0].data).toMatchObject({
      modelName: 'EXPERIMENTAL_F006_1_1_MODEL',
      calibration: 'ES_PLATT',
    });
    expect(prisma.analysisRun.update.mock.calls.at(-1)?.[0].data.metadata).toMatchObject({
      modelId: 'EXPERIMENTAL_F006_1_1_MODEL',
      languageCode: 'es',
      calibrationSource: 'ES_PLATT',
    });
  });

  it('converts AI-service paragraph codepoint ranges to UTF-16 before persisting', async () => {
    const first = 'Un párrafo sintético 😀 con suficiente texto para validar offsets locales.';
    const second = 'La sección siguiente conserva sus límites luego del emoji anterior.';
    const extractedText = `${first}\n\n${second}`;
    const result = aiResult();
    result.segments = [
      {
        paragraphIndex: 0,
        charStart: 0,
        charEnd: Array.from(first).length,
        textHash: sha256(first),
        pageNumber: null,
        words: 11,
        tokens: 15,
        contextTokensUsed: {},
        rawScore: 0.8,
        calibratedScore: 0.8,
        classification: 'MACHINE_SIGNAL',
        signalLevel: 'HIGH',
        confidence: 'HIGH',
      },
      {
        paragraphIndex: 1,
        charStart: Array.from(`${first}\n\n`).length,
        charEnd: Array.from(extractedText).length,
        textHash: sha256(second),
        pageNumber: null,
        words: 10,
        tokens: 13,
        contextTokensUsed: {},
        rawScore: 0.8,
        calibratedScore: 0.8,
        classification: 'MACHINE_SIGNAL',
        signalLevel: 'HIGH',
        confidence: 'HIGH',
      },
    ];
    prisma.document.findUnique.mockResolvedValueOnce({ id: DOC, currentVersion: { id: 'v1', extractedText } });
    ai.analyzeParagraphs.mockResolvedValueOnce(result);

    await service.analyzeDocument(DOC, {
      analyzer: 'V3_ONLY',
      thresholdProfile: 'LOW_FALSE_POSITIVE',
      granularity: 'PARAGRAPH',
      paragraphMode: 'CONTEXTUAL_PARAGRAPH',
    });

    const stored = prisma.analysisSegment.createMany.mock.calls[0][0].data;
    expect(stored.map(({ charStart, charEnd }) => [charStart, charEnd])).toEqual([
      [0, first.length],
      [`${first}\n\n`.length, extractedText.length],
    ]);
  });

  it('returns one canonical rounded percentage from the persisted run score', async () => {
    expect(displayPercent(0.655)).toBe(66);
    expect(displayPercent(null)).toBeNull();
    prisma.analysisRun.findUnique.mockResolvedValueOnce({
      id: RUN,
      documentScore: 0.655,
      modelResults: [{ modelName: 'CANDIDATE_MODEL_V3', calibratedScore: 0.655 }],
      documentVersion: { documentId: DOC },
    });
    const run = await service.getRun(RUN);
    expect(run).toMatchObject({ id: RUN, documentScore: 0.655, documentScorePercent: 66 });
    expect(run.modelResults[0].calibratedScore).toBe(run.documentScore);
  });

  it('includes persisted model results and the same display percentage in history', async () => {
    prisma.analysisRun.findMany.mockResolvedValueOnce([
      { id: RUN, documentScore: 0.655, modelResults: [{ calibratedScore: 0.655 }] },
    ]);
    const history = await service.listForDocument(DOC);
    expect(prisma.analysisRun.findMany.mock.calls.at(-1)?.[0].include).toEqual({
      modelResults: true,
      segments: { select: { classification: true, calibratedScore: true } },
    });
    expect(history.items[0]).toMatchObject({ documentScore: 0.655, documentScorePercent: 66 });
    expect(history.items[0].modelResults[0].calibratedScore).toBe(history.items[0].documentScore);
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
    const seg = {
      paragraphIndex: 0,
      charStart: 0,
      charEnd: 9,
      textHash: sha256(SECRET_TEXT.slice(0, 9)),
      calibratedScore: 0.2,
      signalLevel: 'LOW',
      classification: 'LOW_SIGNAL',
    };
    prisma.analysisRun.findUnique.mockResolvedValueOnce({ id: RUN, textHash: sha256(SECRET_TEXT), segments: [seg],
      documentVersion: { extractedText: SECRET_TEXT } });
    expect((await service.getSegments(RUN)).items[0].text).toBe('Párrafo s');
    prisma.analysisRun.findUnique.mockResolvedValueOnce({ id: RUN, textHash: 'x'.repeat(64), segments: [seg],
      documentVersion: { extractedText: SECRET_TEXT } });
    const stale = await service.getSegments(RUN);
    expect(stale.stale).toBe(true);
    expect(stale.items[0].text).toBeNull();
  });

  it('returns a verified full review document and presentation without changing stored scores', async () => {
    const fixture = [
      { text: 'UNIVERSIDAD SINTÉTICA', score: 0.91, signalLevel: 'HIGH', classification: 'MACHINE_SIGNAL' },
      { text: 'Autor: Ana Ejemplo', score: 0.9, signalLevel: 'HIGH', classification: 'MACHINE_SIGNAL' },
      { text: 'La estructura sintética del problema requiere revisión.', score: 0.92, signalLevel: 'HIGH', classification: 'MACHINE_SIGNAL' },
      { text: 'La descripción sintética del método requiere revisión.', score: 0.51, signalLevel: 'MODERATE', classification: 'MACHINE_SIGNAL' },
      { text: 'Texto breve con señal baja.', score: 0.2, signalLevel: 'LOW', classification: 'LOW_SIGNAL' },
      { text: '1.2 Marco metodológico', score: null, signalLevel: null, classification: 'INSUFFICIENT_TEXT' },
      { text: 'Figura 1. Diagrama sintético del proceso.', score: 0.95, signalLevel: 'HIGH', classification: 'MACHINE_SIGNAL' },
      { text: 'Referencias', score: null, signalLevel: null, classification: 'INSUFFICIENT_TEXT' },
      { text: 'Smith, A. (2024). Referencia sintética.', score: 0.98, signalLevel: 'HIGH', classification: 'MACHINE_SIGNAL' },
    ];
    const extractedText = fixture.map(({ text }) => text).join('\n\n');
    let offset = 0;
    const segments = fixture.map((item, paragraphIndex) => {
      const charStart = offset;
      const charEnd = charStart + item.text.length;
      offset = charEnd + 2;
      return {
        id: `00000000-0000-4000-8000-${String(paragraphIndex + 1).padStart(12, '0')}`,
        paragraphIndex,
        charStart,
        charEnd,
        textHash: sha256(item.text),
        calibratedScore: item.score,
        signalLevel: item.signalLevel,
        classification: item.classification,
        modelName: 'SYNTHETIC_MODEL_V3',
        words: item.text.split(/\s+/u).length,
        tokens: 8,
      };
    });
    const savedScores = segments.map(({ calibratedScore }) => calibratedScore);
    prisma.analysisRun.findUnique.mockResolvedValueOnce({
      id: RUN,
      status: 'COMPLETED',
      threshold: 0.59,
      paragraphMode: 'STRICT_PARAGRAPH',
      textHash: sha256(extractedText),
      metadata: {},
      segments,
      documentVersion: { extractedText },
    });

    const result = await service.getSegments(RUN, { includeDocumentText: true });

    expect(result.documentText).toBe(extractedText);
    expect(result.items.map(({ charStart }) => charStart)).toEqual(
      [...segments].map(({ charStart }) => charStart),
    );
    expect(result.items.map(({ calibratedScore }) => calibratedScore)).toEqual(savedScores);
    expect(result.items[0]?.reviewPresentation).toMatchObject({ highlight: false, excludedReason: 'METADATA' });
    expect(result.items[1]?.reviewPresentation).toMatchObject({ highlight: false, excludedReason: 'METADATA' });
    expect(result.items[2]?.reviewPresentation).toMatchObject({ highlight: true, level: 'HIGH' });
    expect(result.items[2]?.evidence).toMatchObject({ evaluated: true, flagged: true, threshold: 0.59, granularity: 'PARAGRAPH', spans: [] });
    expect(result.items[3]?.reviewPresentation).toMatchObject({ highlight: true, level: 'MODERATE' });
    expect(result.items[3]?.evidence).toMatchObject({ evaluated: true, flagged: false, threshold: 0.59 });
    expect(result.items[4]?.reviewPresentation).toMatchObject({ highlight: false, level: 'LOW' });
    expect(result.items[5]?.reviewPresentation).toMatchObject({ highlight: false, excludedReason: 'HEADING' });
    expect(result.items[5]?.evidence).toMatchObject({ evaluated: false, flagged: false, presentationExcluded: true });
    expect(result.items[6]?.reviewPresentation).toMatchObject({ highlight: false, excludedReason: 'CAPTION' });
    expect(result.items[7]?.reviewPresentation).toMatchObject({ highlight: false, excludedReason: 'REFERENCE_SECTION' });
    expect(result.items[8]?.reviewPresentation).toMatchObject({ highlight: false, excludedReason: 'REFERENCE_SECTION' });
  });

  it('rejects a review document when a segment hash does not match its offsets', async () => {
    const text = 'Párrafo sintético para validación.';
    prisma.analysisRun.findUnique.mockResolvedValueOnce({
      id: RUN,
      textHash: sha256(text),
      segments: [{
        paragraphIndex: 0,
        charStart: 0,
        charEnd: text.length,
        textHash: '0'.repeat(64),
        calibratedScore: 0.9,
        signalLevel: 'HIGH',
        classification: 'MACHINE_SIGNAL',
      }],
      documentVersion: { extractedText: text },
    });

    await expect(service.getSegments(RUN, { includeDocumentText: true })).rejects.toMatchObject({
      status: 409,
      response: { code: 'ANALYSIS_SEGMENT_TEXT_MISMATCH' },
    });
  });

  it('keeps contextual segment offsets and hashes anchored to the target paragraph', async () => {
    const target = 'Este es el párrafo objetivo que se debe puntuar con contexto.';
    const extractedText = `Nota corta previa\n\n${target}\n\nNota corta siguiente`;
    const charStart = extractedText.indexOf(target);
    const segment = {
      paragraphIndex: 1,
      charStart,
      charEnd: charStart + target.length,
      textHash: sha256(target),
      pageNumber: null,
      calibratedScore: 0.65,
      signalLevel: 'HIGH',
      classification: 'MACHINE_SIGNAL',
    };
    prisma.analysisRun.findUnique.mockResolvedValueOnce({
      id: RUN,
      paragraphMode: 'CONTEXTUAL_PARAGRAPH',
      textHash: sha256(extractedText),
      segments: [segment],
      documentVersion: { extractedText },
    });

    const result = await service.getSegments(RUN);

    expect(result.items[0]).toMatchObject({
      paragraphIndex: 1,
      charStart,
      charEnd: charStart + target.length,
      textHash: sha256(target),
      pageNumber: null,
      text: target,
    });
  });

  it('reconstructs contextual target and adjacent paragraphs from the same run version', async () => {
    const beforeText = 'Este es el párrafo anterior completo.';
    const targetText = 'Este es el párrafo objetivo completo.';
    const afterText = 'Este es el párrafo siguiente completo.';
    const extractedText = `${beforeText}\n\n${targetText}\n\n${afterText}`;
    const targetStart = extractedText.indexOf(targetText);
    const afterStart = extractedText.indexOf(afterText);
    const segments = [
      { id: '00000000-0000-4000-8000-000000000001', paragraphIndex: 0, charStart: 0, charEnd: beforeText.length, textHash: sha256(beforeText) },
      { id: '00000000-0000-4000-8000-000000000002', paragraphIndex: 1, charStart: targetStart, charEnd: targetStart + targetText.length, textHash: sha256(targetText) },
      { id: '00000000-0000-4000-8000-000000000003', paragraphIndex: 2, charStart: afterStart, charEnd: afterStart + afterText.length, textHash: sha256(afterText) },
    ];
    prisma.analysisRun.findUnique.mockResolvedValueOnce({
      id: RUN,
      status: 'COMPLETED',
      paragraphMode: 'CONTEXTUAL_PARAGRAPH',
      textHash: sha256(extractedText),
      metadata: { paragraphContext: {
        tokenLimitPerSide: 64,
        measurement: 'tokens_per_window',
        preprocessingProfiles: ['V3_CANONICALIZED_V1'],
        byParagraph: { '1': { V3_CANONICALIZED_V1: { before: 8, after: 11 } } },
      } },
      segments,
      documentVersion: { extractedText },
    });

    const result = await service.getSegmentContext(RUN, segments[1].id);

    expect(result).toMatchObject({
      analysisId: RUN,
      paragraphMode: 'CONTEXTUAL_PARAGRAPH',
      target: { paragraphIndex: 1, charStart: targetStart, charEnd: targetStart + targetText.length, text: targetText },
      before: { paragraphIndex: 0, text: beforeText, tokensUsed: { V3_CANONICALIZED_V1: 8 } },
      after: { paragraphIndex: 2, text: afterText, tokensUsed: { V3_CANONICALIZED_V1: 11 } },
      contextMetadata: { tokenLimitPerSide: 64, measurement: 'tokens_per_window', preprocessingProfiles: ['V3_CANONICALIZED_V1'] },
    });
  });

  it('does not return a segment from another run or document version', async () => {
    const text = 'Párrafo sintético del mismo run.';
    const segment = {
      id: '00000000-0000-4000-8000-000000000011',
      paragraphIndex: 0,
      charStart: 0,
      charEnd: text.length,
      textHash: sha256(text),
    };
    prisma.analysisRun.findUnique.mockResolvedValueOnce({
      id: RUN,
      status: 'COMPLETED',
      paragraphMode: 'CONTEXTUAL_PARAGRAPH',
      textHash: sha256(text),
      metadata: null,
      segments: [segment],
      documentVersion: { extractedText: text },
    });

    await expect(service.getSegmentContext(RUN, '00000000-0000-4000-8000-000000000099'))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.analysisRun.findUnique).toHaveBeenCalledWith({
      where: { id: RUN },
      include: { segments: { orderBy: { paragraphIndex: 'asc' } }, documentVersion: true },
    });
  });

  it('reports unavailable neighbours at the first and last paragraph boundaries', async () => {
    const firstText = 'Primer párrafo contextual suficientemente largo.';
    const middleText = 'Párrafo del medio con contenido sintético.';
    const lastText = 'Último párrafo contextual suficientemente largo.';
    const extractedText = `${firstText}\n\n${middleText}\n\n${lastText}`;
    const middleStart = extractedText.indexOf(middleText);
    const lastStart = extractedText.indexOf(lastText);
    const segments = [
      { id: '00000000-0000-4000-8000-000000000021', paragraphIndex: 0, charStart: 0, charEnd: firstText.length, textHash: sha256(firstText) },
      { id: '00000000-0000-4000-8000-000000000022', paragraphIndex: 1, charStart: middleStart, charEnd: middleStart + middleText.length, textHash: sha256(middleText) },
      { id: '00000000-0000-4000-8000-000000000023', paragraphIndex: 2, charStart: lastStart, charEnd: lastStart + lastText.length, textHash: sha256(lastText) },
    ];
    const makeRun = () => ({
      id: RUN,
      status: 'COMPLETED',
      paragraphMode: 'CONTEXTUAL_PARAGRAPH',
      textHash: sha256(extractedText),
      metadata: null,
      segments,
      documentVersion: { extractedText },
    });
    prisma.analysisRun.findUnique.mockResolvedValueOnce(makeRun()).mockResolvedValueOnce(makeRun());

    const first = await service.getSegmentContext(RUN, segments[0].id);
    const last = await service.getSegmentContext(RUN, segments[2].id);

    expect(first.before).toEqual({ paragraphIndex: null, text: null, tokensUsed: null });
    expect(last.after).toEqual({ paragraphIndex: null, text: null, tokensUsed: null });
  });

  it('paginates, sorts and filters the segment list for the research UI', async () => {
    const extractedText = 'Low high insufficient';
    const rows = [
      { paragraphIndex: 0, charStart: 0, charEnd: 3, textHash: sha256('Low'), calibratedScore: 0.2, signalLevel: 'LOW', classification: 'LOW_SIGNAL' },
      { paragraphIndex: 1, charStart: 4, charEnd: 8, textHash: sha256('high'), calibratedScore: 0.9, signalLevel: 'HIGH', classification: 'MACHINE_SIGNAL' },
      { paragraphIndex: 2, charStart: 9, charEnd: 21, textHash: sha256('insufficient'), calibratedScore: null, signalLevel: null, classification: 'INSUFFICIENT_TEXT' },
    ];
    prisma.analysisRun.findUnique.mockResolvedValueOnce({ id: RUN, textHash: sha256(extractedText), segments: rows,
      documentVersion: { extractedText } });
    const page = await service.getSegments(RUN, { page: 1, pageSize: 1, sort: 'SCORE_DESC', filter: 'ALL' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].paragraphIndex).toBe(1);
    expect(page).toMatchObject({ page: 1, pageSize: 1, total: 3, pages: 3 });

    prisma.analysisRun.findUnique.mockResolvedValueOnce({ id: RUN, textHash: sha256(extractedText), segments: rows,
      documentVersion: { extractedText } });
    const insufficient = await service.getSegments(RUN, { page: 1, pageSize: 20, sort: 'PARAGRAPH', filter: 'INSUFFICIENT' });
    expect(insufficient.total).toBe(1);
    expect(insufficient.items[0]).toMatchObject({ paragraphIndex: 2, text: 'insufficient' });
  });

  it('creates a new run from an exact cache hit without calling model inference', async () => {
    ai.listAnalyzerModels.mockResolvedValue({ models: [{
      model: 'CANDIDATE_MODEL_V3', status: 'CANDIDATE', state: 'AVAILABLE', artifactPresent: true,
      artifactValid: true, servable: true, variant: 'spec-v3', modelVersion: 'test-v3',
      preprocessing: ['V3_PREPROCESSING_V1'],
    }] });
    prisma.analysisRun.findMany.mockResolvedValueOnce([{
      id: 'cached-run', threshold: 0.59, documentAggregation: 'token_weighted_mean', documentScore: 0.42,
      documentClassification: 'LOW_SIGNAL', signalLevel: 'MODERATE', scoredSegments: 1, insufficientSegments: 1,
      modelResults: [{ modelVersionId: 'mv3', modelName: 'CANDIDATE_MODEL_V3', modelVariant: 'test-v3', rawScore: 0.31,
        calibratedScore: 0.42, thresholdProfile: 'BALANCED', threshold: 0.59, classification: 'LOW_SIGNAL', confidence: 'LOW',
        calibration: 'isotonic', preprocessing: 'V3_PREPROCESSING_V1', inferenceMs: 12 }],
      segments: [{ paragraphIndex: 0, textHash: sha256(SECRET_TEXT.split('\n\n')[0]!), charStart: 0,
        charEnd: SECRET_TEXT.split('\n\n')[0]!.length, pageNumber: null,
        words: 8, tokens: 14, rawScore: 0.5, calibratedScore: 0.42, classification: 'LOW_SIGNAL',
        signalLevel: 'MODERATE', confidence: 'LOW', modelVersionId: 'mv3', modelName: 'CANDIDATE_MODEL_V3' }],
    }]);
    const out = await service.analyzeDocument(DOC, { analyzer: 'V3_ONLY', thresholdProfile: 'BALANCED',
      granularity: 'PARAGRAPH', paragraphMode: 'STRICT_PARAGRAPH' });
    expect(out.id).toBe(RUN);
    expect(prisma.analysisRun.create).toHaveBeenCalledOnce();
    expect(ai.analyzeParagraphs).not.toHaveBeenCalled();
    expect(prisma.analysisRun.update.mock.calls.at(-1)?.[0].data).toMatchObject({
      status: AnalysisRunStatus.COMPLETED,
      threshold: 0.59,
      documentAggregation: 'token_weighted_mean',
      documentScore: 0.42,
      documentClassification: 'LOW_SIGNAL',
      signalLevel: 'MODERATE',
      scoredSegments: 1,
      insufficientSegments: 1,
      inferenceMs: 0,
      metadata: { cacheHit: true, reusedAnalysisId: 'cached-run' },
    });
    expect(prisma.analysisModelResult.create.mock.calls[0][0].data).toMatchObject({
      analysisRunId: RUN,
      modelName: 'CANDIDATE_MODEL_V3',
      rawScore: 0.31,
      calibratedScore: 0.42,
      threshold: 0.59,
      thresholdProfile: 'BALANCED',
      calibration: 'isotonic',
      preprocessing: 'V3_PREPROCESSING_V1',
      inferenceMs: 0,
    });
    expect(prisma.analysisSegment.createMany.mock.calls[0][0].data[0]).toMatchObject({
      analysisRunId: RUN,
      modelName: 'CANDIDATE_MODEL_V3',
      rawScore: 0.5,
      calibratedScore: 0.42,
      classification: 'LOW_SIGNAL',
      signalLevel: 'MODERATE',
      confidence: 'LOW',
    });
  });

  it('does not reuse a cache entry whose persisted global and model scores differ', async () => {
    ai.listAnalyzerModels.mockResolvedValue({ models: [{
      model: 'CANDIDATE_MODEL_V3', status: 'CANDIDATE', state: 'AVAILABLE', artifactPresent: true,
      artifactValid: true, servable: true, variant: 'spec-v3', modelVersion: 'test-v3',
      preprocessing: ['V3_PREPROCESSING_V1'],
    }] });
    prisma.analysisRun.findMany.mockResolvedValueOnce([{
      id: 'inconsistent-cache', threshold: 0.59, documentAggregation: 'token_weighted_mean', documentScore: 0.43,
      modelResults: [{ modelVersionId: 'mv3', modelName: 'CANDIDATE_MODEL_V3', modelVariant: 'test-v3', rawScore: 0.31,
        calibratedScore: 0.42, thresholdProfile: 'BALANCED', threshold: 0.59, classification: 'LOW_SIGNAL', confidence: 'LOW',
        calibration: 'isotonic', preprocessing: 'V3_PREPROCESSING_V1', inferenceMs: 12 }],
      segments: [],
    }]);
    ai.analyzeParagraphs.mockResolvedValue(aiResult());
    await service.analyzeDocument(DOC, { analyzer: 'V3_ONLY', thresholdProfile: 'BALANCED',
      granularity: 'PARAGRAPH', paragraphMode: 'STRICT_PARAGRAPH' });
    expect(ai.analyzeParagraphs).toHaveBeenCalledOnce();
    expect(prisma.analysisRun.update.mock.calls.at(-1)?.[0].data.documentScore).toBe(0.42);
  });

  it('uses distinct cache identity and candidate filters for strict and contextual runs', async () => {
    ai.listAnalyzerModels.mockResolvedValue({ models: [{
      model: 'CANDIDATE_MODEL_V3', status: 'CANDIDATE', state: 'AVAILABLE', artifactPresent: true,
      artifactValid: true, servable: true, variant: 'spec-v3', modelVersion: 'test-v3',
      preprocessing: ['V3_PREPROCESSING_V1'],
    }] });
    prisma.analysisRun.findMany.mockResolvedValue([]);
    ai.analyzeParagraphs.mockResolvedValue(aiResult());

    await service.analyzeDocument(DOC, { analyzer: 'V3_ONLY', thresholdProfile: 'LOW_FALSE_POSITIVE',
      granularity: 'PARAGRAPH', paragraphMode: 'CONTEXTUAL_PARAGRAPH' });
    await service.analyzeDocument(DOC, { analyzer: 'V3_ONLY', thresholdProfile: 'LOW_FALSE_POSITIVE',
      granularity: 'PARAGRAPH', paragraphMode: 'STRICT_PARAGRAPH' });

    expect(prisma.analysisRun.findMany.mock.calls.map(([args]) => args.where.paragraphMode)).toEqual([
      'CONTEXTUAL_PARAGRAPH', 'STRICT_PARAGRAPH',
    ]);
    const cacheKeys = prisma.analysisRun.update.mock.calls.map(([args]) => args.data.metadata.cacheKey);
    expect(cacheKeys).toHaveLength(2);
    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
    expect(ai.analyzeParagraphs).toHaveBeenCalledTimes(2);
  });

  it('compares two analyses paragraph by paragraph', async () => {
    const run = (id: string, scores: number[], doc: number) => ({
      id, status: 'COMPLETED', analyzerMode: 'V3_ONLY', thresholdProfile: 'BALANCED', threshold: 0.5, documentScore: doc,
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
    expect(out.details.thresholdReview).toMatchObject({
      previousFlagged: 1,
      currentFlagged: 1,
      newlyFlagged: 1,
      noLongerFlagged: 1,
      stillFlagged: 0,
    });
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
  it('reflects installed experimental artifacts without changing scientific status or implying a locked checksum', async () => {
    const prisma = makePrisma();
    prisma.modelVersion.findMany.mockResolvedValue([]);
    prisma.modelVersion.findUnique.mockResolvedValue({ name: 'EXPERIMENTAL_F006_1_1_MODEL', metadata: {} });
    const liveModel = {
      model: 'EXPERIMENTAL_F006_1_1_MODEL', state: 'READY', status: 'EXPERIMENTAL',
      available: true, servable: true, active: false, candidate: false,
      artifactPresent: true, artifactValid: true, artifactChecksumExpected: false, artifactChecksumValidated: false,
      thresholdProfiles: ['BALANCED'], preprocessing: ['V3_CANONICALIZED_V1'], warnings: [],
    };
    const ai = { listAnalyzerModels: vi.fn().mockResolvedValue({ models: [liveModel] }) };
    const svc = new AnalyzerModelsService(prisma as unknown as PrismaService, ai as unknown as AiService,
      {} as ModelVersionService);
    const installed = (await svc.list()).items.find((model) => model.name === liveModel.model);
    expect(installed).toMatchObject({
      available: true, servable: true, active: false, candidate: false,
      artifactChecksumExpected: false, artifactChecksumValidated: false,
      researchMetadata: {
        artifactAvailableLocally: true, artifactChecksumValidated: false,
        strictSupported: 'SUPPORTED', contextualSupported: 'SUPPORTED', paragraphStability: 'NOT_EVALUATED',
      },
    });
    expect(installed?.warnings.join(' ')).not.toMatch(/not present locally|not servable/);
    expect(installed?.researchMetadata?.limitations.join(' ')).not.toContain('no está instalado');
    expect((await svc.metrics(liveModel.model)).researchMetadata).toMatchObject({
      artifactAvailableLocally: true, strictSupported: 'SUPPORTED', contextualSupported: 'SUPPORTED',
      paragraphStability: 'NOT_EVALUATED', artifactChecksumValidated: false,
    });
    ai.listAnalyzerModels.mockResolvedValueOnce({ models: [{ ...liveModel,
      state: 'UNAVAILABLE', available: false, servable: false, artifactPresent: false, artifactValid: false,
    }] });
    const missing = (await svc.list()).items.find((model) => model.name === liveModel.model);
    expect(missing?.researchMetadata).toMatchObject({
      artifactAvailableLocally: false, strictSupported: 'UNVERIFIED_ARTIFACT_UNAVAILABLE',
      contextualSupported: 'UNVERIFIED_ARTIFACT_UNAVAILABLE', paragraphStability: 'NOT_EVALUATED',
    });
    expect(missing?.warnings).toContain('El artefacto del modelo no está instalado o no pasó su validación local.');
  });

  it('merges registry metadata with live availability without exposing storage paths', async () => {
    const prisma = makePrisma();
    prisma.modelVersion.findMany.mockResolvedValue([{ id: 'mv2', name: 'CANDIDATE_MODEL_V2', status: 'CANDIDATE',
      architecture: 'microsoft/mdeberta-v3-base', variant: 'X', artifactProvider: 'GOOGLE_DRIVE',
      artifactPath: 'MyDrive/turniting/secret/path', limitations: ['lim'] }]);
    const ai = { listAnalyzerModels: vi.fn().mockResolvedValue({ policy: {
      localPreferredAnalyzer: 'EXPERIMENTAL_F006_1_MODEL', localPreferredAvailable: true,
      resolvedLocalPreferredAnalyzer: 'EXPERIMENTAL_F006_1_MODEL',
      localPreferredFallback: 'CANDIDATE_MODEL_V3', localPreferredFallbackAvailable: true,
      localPreferredWarning: null,
    }, models: [
      { model: 'CANDIDATE_MODEL_V3', state: 'UNAVAILABLE', status: 'CANDIDATE', servable: true, warnings: ['fpr'],
        thresholdProfiles: [], preprocessing: ['V3_CANONICALIZED_V1'] }] }) };
    const svc = new AnalyzerModelsService(prisma as unknown as PrismaService, ai as unknown as AiService,
      {} as ModelVersionService);
    const out = await svc.list();
    expect(out.items.find((m) => m.name === 'CANDIDATE_MODEL_V3')?.availability).toBe('UNAVAILABLE');
    expect(out.items.find((m) => m.name === 'CANDIDATE_MODEL_V2')?.registeredInDatabase).toBe(true);
    expect(out.activeModel).toBe('NONE');
    expect(out).toMatchObject({
      localPreferredAnalyzer: 'EXPERIMENTAL_F006_1_MODEL',
      localPreferredAvailable: true,
      resolvedLocalPreferredAnalyzer: 'EXPERIMENTAL_F006_1_MODEL',
      localPreferredFallback: 'CANDIDATE_MODEL_V3',
      localPreferredFallbackAvailable: true,
      localPreferredWarning: null,
      unifiedReady: false,
      spanServingReady: false,
      paragraphHighlighting: true,
      spanHighlighting: false,
      granularity: 'PARAGRAPH',
    });
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
    const f0061 = out.items.find((m) => m.name === 'EXPERIMENTAL_F006_1_MODEL');
    expect(f0061).toMatchObject({
      registeredInRegistry: true,
      status: 'EXPERIMENTAL',
      availability: 'UNAVAILABLE',
      available: false,
      active: false,
      candidate: false,
      artifactPresent: false,
      servable: false,
      metrics: {
        evaluationSet: 'F006_1_FINAL_HOLDOUT',
        macroF1: 0.8913183115501333,
        spanishF1: 0.9192178110962022,
        spanishHumanFpr: 0.05490909090909091,
        mixedRecall: 0.63,
        spanTokenF1: 0.826,
      },
      researchMetadata: {
        gatesPassed: 7,
        gatesTotal: 11,
        failedGates: [
          'A_overall_human_fpr_le_0.05',
          'D_unseen_generator_fpr_le_0.10',
          'E_mixed_recall_ge_0.64',
          'H_span_f1_ge_0.86',
        ],
        calibration: { global: 'GLOBAL_ISO', spanish: 'ES_ISO', globalThreshold: 0.6443, spanishThreshold: 0.6443 },
        paragraphStability: 'NOT_EVALUATED',
      },
    });
    expect(JSON.stringify(f0061)).not.toContain('MyDrive');
    const f00611 = out.items.find((m) => m.name === 'EXPERIMENTAL_F006_1_1_MODEL');
    expect(f00611).toMatchObject({
      status: 'EXPERIMENTAL',
      availability: 'UNAVAILABLE',
      artifactPresent: false,
      artifactValid: false,
      available: false,
      active: false,
      candidate: false,
      servable: false,
      metrics: {
        macroF1: 0.8704,
        overallHumanFpr: 0.0541,
        spanishHumanFpr: 0.019,
        academicHumanFpr: 0.0307,
        unseenGeneratorHumanFpr: 0.0967,
        mixedRecall: 0.5832,
        aiEditedF1: 0.9023,
        oodF1: 0.9383,
        spanTokenF1: 0.7694,
      },
      researchMetadata: {
        parentModel: 'EXPERIMENTAL_F006_MODEL',
        gatesPassed: 8,
        gatesTotal: 11,
        failedGates: [
          'A_overall_human_fpr_le_0.05',
          'H_mixed_recall_ge_0.65',
          'I_span_token_f1_ge_0.86',
        ],
        calibration: {
          global: 'GLOBAL_ISO',
          spanish: 'ES_PLATT',
          globalThreshold: 0.767241379310345,
          spanishThreshold: 0.767241379310345,
        },
        holdoutCounts: { documents: 30363, humanDocuments: 13650, spanishDocuments: 5530, leakageCount: 0 },
      },
    });
    expect(out.items.some((m) => m.name === 'EXPERIMENTAL_SPAN_MODEL_V1')).toBe(false);
    expect(out.nonServingResearchModels).toContainEqual(expect.objectContaining({
      name: 'EXPERIMENTAL_SPAN_MODEL_V1', registeredForServing: false, servable: false, spanServingReady: false,
    }));
    ai.listAnalyzerModels.mockResolvedValueOnce({ models: [{
      model: 'EXPERIMENTAL_F006_1_MODEL', status: 'EXPERIMENTAL', state: 'AVAILABLE',
      available: true, active: false, candidate: false, artifactPresent: true, artifactValid: true, servable: true,
      variant: 'f0061-test', modelVersion: 'f0061-test', preprocessing: ['V3_CANONICALIZED_V1'],
      thresholdProfiles: [], warnings: [],
    }] });
    const mockedAvailable = await svc.list();
    expect(mockedAvailable.items.find((m) => m.name === 'EXPERIMENTAL_F006_1_MODEL')).toMatchObject({
      status: 'EXPERIMENTAL', available: true, active: false, candidate: false, servable: true,
    });
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
