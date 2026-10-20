import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiService } from '../ai/ai.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AnalysisController } from './analysis.controller.js';
import { AnalysisService, sha256 } from './analysis.service.js';

const RUN = '12121212-1212-4212-8212-121212121212';
const DOCUMENT = '34343434-3434-4434-8434-343434343434';
const VERSION = '56565656-5656-4656-8656-565656565656';

interface SyntheticEntry {
  text: string;
  score: number | null;
  structuralType?: string;
  structuralGroupId?: string;
  kind?: string;
}

function fixture(entries: readonly SyntheticEntry[]) {
  let cursor = 0;
  const segments = entries.map((entry, paragraphIndex) => {
    const charStart = cursor;
    cursor += entry.text.length + 2;
    return {
      id: `00000000-0000-4000-8000-${String(paragraphIndex + 1).padStart(12, '0')}`,
      analysisRunId: RUN,
      paragraphIndex,
      textHash: sha256(entry.text.replace(/\s+/gu, ' ').trim()),
      charStart,
      charEnd: charStart + entry.text.length,
      pageNumber: 1,
      words: entry.text.split(/\s+/u).length,
      tokens: entry.text.split(/\s+/u).length * 2,
      rawScore: entry.score,
      calibratedScore: entry.score,
      classification: entry.score === null ? 'INSUFFICIENT_TEXT' : entry.score >= 0.59 ? 'MACHINE_SIGNAL' : 'LOW_SIGNAL',
      signalLevel: entry.score === null ? null : 'HIGH',
      modelName: 'SYNTHETIC_ENDPOINT_TEST',
      confidence: null,
    };
  });
  const extractedText = entries.map(entry => entry.text).join('\n\n');
  const presentationStructureHints = Object.fromEntries(entries.flatMap((entry, index) => {
    if (!entry.structuralType && !entry.kind) return [];
    const segment = segments[index]!;
    return [[String(index), {
      textHash: segment.textHash, charStart: segment.charStart, charEnd: segment.charEnd,
      ...(entry.structuralType ? { structuralType: entry.structuralType } : {}),
      ...(entry.kind ? { kind: entry.kind } : {}),
      ...(entry.structuralGroupId ? { structuralGroupId: entry.structuralGroupId } : {}),
    }]];
  }));
  return {
    id: RUN,
    status: 'COMPLETED',
    documentVersionId: VERSION,
    sourceDocumentId: DOCUMENT,
    sourceDocumentVersionId: VERSION,
    threshold: 0.59,
    documentScore: 0.434,
    analyzerMode: 'ENSEMBLE',
    analyzerVersion: 'synthetic-endpoint-test',
    thresholdProfile: 'BALANCED',
    textHash: sha256(extractedText),
    metadata: { presentationStructureHints },
    segments,
    documentVersion: { id: VERSION, documentId: DOCUMENT, extractedText },
  };
}

function standardFixture() {
  return fixture([
    { text: 'Autor: Persona Sintética', score: null, structuralType: 'METADATA' },
    { text: 'ORCID: 0000-0000-0000-0000', score: null, structuralType: 'METADATA' },
    { text: 'El primer párrafo sintético presenta resultados verificables del procedimiento.', score: 0.8, kind: 'PARAGRAPH' },
    { text: 'El segundo párrafo sintético explica la metodología de evaluación del caso.', score: 0.61, kind: 'PARAGRAPH' },
    { text: 'El tercer párrafo sintético compara observaciones del experimento ficticio.', score: 0.9, kind: 'PARAGRAPH' },
    { text: 'El cuarto párrafo sintético conserva exactamente el umbral almacenado.', score: 0.59, kind: 'PARAGRAPH' },
    ...Array.from({ length: 20 }, (_, index) => ({
      text: `celda ${index + 1} de datos sintéticos`, score: null,
      structuralType: 'TABLE_CELL', structuralGroupId: 'synthetic-table-1',
    })),
    { text: 'References: Smith et al. (2025). Synthetic bibliographic entry.', score: 0.91 },
    { text: 'García (2024). Another synthetic bibliographic entry.', score: 0.83 },
  ]);
}

describe('read-only technical presentation endpoint', () => {
  let prisma: {
    analysisRun: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    analysisSegment: { createMany: ReturnType<typeof vi.fn> };
    documentVersion: { update: ReturnType<typeof vi.fn> };
  };
  let ai: { analyzeParagraphs: ReturnType<typeof vi.fn>; alignVersions: ReturnType<typeof vi.fn> };
  let service: AnalysisService;
  let capturedLogs: string[];

  beforeEach(() => {
    prisma = {
      analysisRun: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
      analysisSegment: { createMany: vi.fn() },
      documentVersion: { update: vi.fn() },
    };
    ai = { analyzeParagraphs: vi.fn(), alignVersions: vi.fn() };
    service = new AnalysisService(prisma as unknown as PrismaService, ai as unknown as AiService);
    capturedLogs = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => { capturedLogs.push(String(message)); });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('returns grouped structure and every exact local score from one explicit persisted run', async () => {
    const run = standardFixture();
    prisma.analysisRun.findUnique.mockResolvedValue(run);
    const result = await new AnalysisController(service).presentation(RUN);

    expect(prisma.analysisRun.findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { id: RUN },
      include: { segments: { orderBy: { paragraphIndex: 'asc' } }, documentVersion: true },
    });
    expect(result.analysisRunId).toBe(RUN);
    expect(result.counts).toMatchObject({
      totalSegments: 28, evaluated: 6, insufficient: 22,
      rawFlaggedCount: 6, presentationExcludedFlagged: 2, actionableHighlightCount: 4,
      evaluatedSegments: 6, insufficientSegments: 22,
    });
    expect(result.audit).toMatchObject({
      sourceSegmentsTotal: 28, sourceSegmentsRepresented: 28,
      sourceSegmentsLost: 0, sourceSegmentsDuplicated: 0,
      evaluatedDisplayUnits: 6,
    });
    expect(result.displayUnits).toHaveLength(7);
    expect(result.displayUnits.find(unit => unit.type === 'METADATA_GROUP')?.sourceSegmentIds).toEqual([0, 1]);
    expect(result.displayUnits.find(unit => unit.type === 'TABLE_GROUP')?.sourceSegmentIds).toHaveLength(20);
    expect(result.displayUnits.find(unit => unit.type === 'REFERENCE_GROUP')?.sourceSegmentIds).toEqual([26, 27]);
    expect(result.displayUnits.filter(unit => unit.type === 'EVALUATED_SEGMENT').map(unit => unit.label))
      .toEqual(Array(4).fill('PÁRRAFO'));
    expect(result.displayUnits.flatMap(unit => unit.evaluatedSegments).map(item => item.score))
      .toEqual([0.8, 0.61, 0.9, 0.59, 0.91, 0.83]);
    expect(result.displayUnits.flatMap(unit => unit.evaluatedSegments).map(item => item.threshold))
      .toEqual(Array(6).fill(0.59));
    expect(result.actionableParagraphIndices).toEqual([2, 3, 4, 5]);
    expect(result.referenceAudit).toEqual({
      referenceSectionStartSegment: 26, referenceSegmentsCount: 2,
      referenceRawFlagged: 2, referenceActionableHighlights: 0,
    });
    expect(result.displayUnits.every(unit => !('score' in unit))).toBe(true);
  });

  it('retains exact evaluated table annotations inside one explicit mixed-score table group', async () => {
    const run = fixture(Array.from({ length: 10 }, (_, index) => ({
      text: `celda ${index + 1} de contenido sintético`,
      score: index === 3 ? 0.63241 : index === 7 ? 0.2 : null,
      structuralType: 'TABLE_CELL', structuralGroupId: 'synthetic-table-mixed',
    })));
    prisma.analysisRun.findUnique.mockResolvedValue(run);
    const result = await service.getTechnicalPresentation(RUN);

    expect(result.displayUnits).toHaveLength(1);
    expect(result.displayUnits[0]).toMatchObject({ type: 'TABLE_GROUP', sourceSegmentIds: Array.from({ length: 10 }, (_, index) => index) });
    expect(result.displayUnits[0]!.evaluatedSegments.map(item => ({ score: item.score, flagged: item.flagged, threshold: item.threshold })))
      .toEqual([{ score: 0.63241, flagged: true, threshold: 0.59 }, { score: 0.2, flagged: false, threshold: 0.59 }]);
    expect(result.counts).toMatchObject({ totalSegments: 10, evaluated: 2, insufficient: 8, rawFlaggedCount: 1 });
    expect('score' in result.displayUnits[0]!).toBe(false);
  });

  it('does not mutate scientific source data, write persistence, invoke inference, or log source text', async () => {
    const run = standardFixture();
    const before = structuredClone(run);
    prisma.analysisRun.findUnique.mockResolvedValue(run);
    await service.getTechnicalPresentation(RUN);

    expect(run).toEqual(before);
    expect(prisma.analysisRun.create).not.toHaveBeenCalled();
    expect(prisma.analysisRun.update).not.toHaveBeenCalled();
    expect(prisma.analysisSegment.createMany).not.toHaveBeenCalled();
    expect(prisma.documentVersion.update).not.toHaveBeenCalled();
    expect(ai.analyzeParagraphs).not.toHaveBeenCalled();
    expect(ai.alignVersions).not.toHaveBeenCalled();
    expect(capturedLogs).toHaveLength(1);
    expect(JSON.parse(capturedLogs[0]!)).toMatchObject({
      event: 'technical_presentation_built', analysisRunId: RUN, sourceSegments: 28, displayUnits: 7,
    });
    expect(capturedLogs.join('\n')).not.toContain(run.documentVersion.extractedText);
    expect(capturedLogs.join('\n')).not.toContain('Smith');
  });

  it('propagates the existing stale-source guard without producing grouped output or invoking AI', async () => {
    const run = standardFixture();
    prisma.analysisRun.findUnique.mockResolvedValue({ ...run, textHash: sha256('different synthetic source') });
    await expect(service.getTechnicalPresentation(RUN)).rejects.toBeInstanceOf(ConflictException);
    expect(ai.analyzeParagraphs).not.toHaveBeenCalled();
    expect(prisma.analysisRun.update).not.toHaveBeenCalled();
  });

  it('rejects an unknown run without selecting a latest document analysis', async () => {
    prisma.analysisRun.findUnique.mockResolvedValue(null);
    await expect(service.getTechnicalPresentation(RUN)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.analysisRun.findUnique).toHaveBeenCalledTimes(1);
    expect(ai.analyzeParagraphs).not.toHaveBeenCalled();
  });
});
