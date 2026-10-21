import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AnalysisClassification, AnalysisRunStatus, AnalyzerMode, Prisma } from '@prisma/client';
import { AiService, type AiAnalyzerModelStatus, type AiAnalyzerSegment, type AnalyzerModeName } from '../ai/ai.service.js';
import {
  convertPythonSegmentOffsetsToUtf16,
  createReviewDocumentContext,
  getReviewEvidence,
  getReviewPresentation,
  getReviewStructuralType,
  normalizeReviewSegmentOffsets,
  ReportReviewIntegrityError,
  type ReviewSegment,
} from './review-presentation.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { buildTechnicalDisplayUnits, isTechnicalEvaluated, isTechnicalFlagged, isPresentationExcluded, TECHNICAL_UNIT_LABELS } from '../reports/technical-display.js';
import type { AIReportParagraph } from '../reports/report.contracts.js';
import { presentationStructureHint } from './presentation-structure.js';
import { REVIEW_PRESENTATION_POLICY } from './review-highlight-policy.js';
import { isReviewHighlighted } from '../reports/technical-display.js';
import type { AnalysisSegmentsQueryDto, AnalyzeDocumentDto, CompareAnalysesDto } from './dto/analysis.dto.js';

export const ANALYZER_VERSION = 'f005-local-analyzer-v1';
const MODEL_FOR_MODE: Record<string, string> = {
  V2_ONLY: 'CANDIDATE_MODEL_V2',
  V3_ONLY: 'CANDIDATE_MODEL_V3',
  ENSEMBLE: 'ENSEMBLE_V2_V3',
  F006_1_ONLY: 'EXPERIMENTAL_F006_1_MODEL',
  F006_1_1_ONLY: 'EXPERIMENTAL_F006_1_1_MODEL',
};

const REVIEW_CAPABILITIES = {
  paragraphHighlighting: true,
  spanHighlighting: false,
} as const;

function evaluatedSegment(segment: { classification: string; calibratedScore: number | null }) {
  return segment.classification !== 'INSUFFICIENT_TEXT' &&
    typeof segment.calibratedScore === 'number' && Number.isFinite(segment.calibratedScore);
}

function flaggedSegment(
  segment: { classification: string; calibratedScore: number | null },
  threshold: number | null,
) {
  return evaluatedSegment(segment) && typeof threshold === 'number' &&
    Number.isFinite(threshold) && segment.calibratedScore! >= threshold;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export type AnalysisCacheKeyInput = {
  modelId: string;
  modelVersion: string;
  preprocessingVersion: string;
  calibrationProfile: string;
  paragraphMode: string;
  textVersionHash: string;
  customThreshold?: number;
  granularity: string;
  analyzerVersion: string;
};

export function buildAnalysisCacheKey(input: AnalysisCacheKeyInput): string {
  return sha256([
    input.modelId,
    input.modelVersion,
    input.preprocessingVersion,
    input.calibrationProfile,
    input.paragraphMode,
    input.textVersionHash,
    input.customThreshold ?? '',
    input.granularity,
    input.analyzerVersion,
  ].join('\0'));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function paragraphContextTokenCounts(
  metadata: unknown,
  paragraphIndex: number,
  side: 'before' | 'after',
): Record<string, number> | null {
  const paragraphContext = asRecord(asRecord(metadata)?.paragraphContext);
  const byParagraph = asRecord(paragraphContext?.byParagraph);
  const usage = asRecord(byParagraph?.[String(paragraphIndex)]);
  if (!usage) return null;
  const counts = Object.entries(usage).flatMap(([profile, value]) => {
    const count = asRecord(value)?.[side];
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
      ? [[profile, count] as const]
      : [];
  });
  return counts.length ? Object.fromEntries(counts) : null;
}

export function displayPercent(score: number | null | undefined): number | null {
  return score === null || score === undefined || !Number.isFinite(score)
    ? null
    : Math.round(score * 100);
}

export function driftStats(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return {
    n: sorted.length,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    median: sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
    p90: q(0.9),
    p95: q(0.95),
    max: sorted[sorted.length - 1],
  };
}

/**
 * F005 local AI analyzer runs. Results are an independent "AI signal" estimate, not a
 * Turnitin score. Logs carry ids, model, duration and status only (never document text).
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
  ) {}

  async analyzeDocument(documentId: string, dto: AnalyzeDocumentDto) {
    if (dto.thresholdProfile === 'CUSTOM' && dto.customThreshold === undefined) {
      throw new BadRequestException('CUSTOM threshold profile needs customThreshold');
    }
    const document = await this.prisma.document.findUnique({ where: { id: documentId }, include: { currentVersion: true } });
    if (!document) throw new NotFoundException('Document not found');
    const version = document.currentVersion;
    const text = version?.extractedText ?? '';
    if (!version || !text.trim()) throw new ConflictException('Document has no extracted text to analyze');
    const textHash = sha256(text);
    const usesExplicitLanguage = dto.analyzer === 'F006_1_ONLY' || dto.analyzer === 'F006_1_1_ONLY';
    const languageCode = usesExplicitLanguage ? (dto.languageCode ?? 'other') : undefined;
    const cacheCalibrationProfile = languageCode
      ? `${dto.thresholdProfile}:${languageCode}`
      : dto.thresholdProfile;

    const run = await this.prisma.analysisRun.create({
      data: {
        documentVersionId: version.id,
        status: AnalysisRunStatus.RUNNING,
        analyzerMode: dto.analyzer as AnalyzerMode,
        analyzerVersion: ANALYZER_VERSION,
        thresholdProfile: dto.thresholdProfile,
        granularity: dto.granularity,
        paragraphMode: dto.paragraphMode,
        textHash,
      },
    });
    const started = Date.now();
    const cacheIdentity = await this.cacheIdentity(dto.analyzer);
    if (cacheIdentity) {
      const cacheKey = buildAnalysisCacheKey({
        ...cacheIdentity,
        calibrationProfile: cacheCalibrationProfile,
        paragraphMode: dto.paragraphMode,
        textVersionHash: textHash,
        customThreshold: dto.customThreshold,
        granularity: dto.granularity,
        analyzerVersion: ANALYZER_VERSION,
      });
      const candidates = await this.prisma.analysisRun.findMany({
        where: {
          documentVersionId: version.id,
          textHash,
          analyzerMode: dto.analyzer as AnalyzerMode,
          analyzerVersion: ANALYZER_VERSION,
          thresholdProfile: dto.thresholdProfile,
          granularity: dto.granularity,
          paragraphMode: dto.paragraphMode,
          status: AnalysisRunStatus.COMPLETED,
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { modelResults: true, segments: { orderBy: { paragraphIndex: 'asc' } } },
      });
      const matchesCachedModel = (result: (typeof candidates)[number]['modelResults'][number], candidate: (typeof candidates)[number]) =>
        result.modelName === MODEL_FOR_MODE[dto.analyzer]
        && result.modelVariant === cacheIdentity.modelVersion
        && result.preprocessing === cacheIdentity.preprocessingVersion
        && result.thresholdProfile === dto.thresholdProfile
        && result.threshold === candidate.threshold
        && result.calibratedScore === candidate.documentScore
        && (dto.thresholdProfile !== 'CUSTOM' || result.threshold === dto.customThreshold)
        && (languageCode === undefined || (asRecord(candidate.metadata)?.languageCode ?? 'other') === languageCode);
      const cached = candidates.find((candidate) => {
        const matches = candidate.documentAggregation !== null
          && candidate.documentScore !== null
          && candidate.threshold !== null
          && candidate.modelResults.some((result) => matchesCachedModel(result, candidate));
        if (!matches) return false;
        try {
          normalizeReviewSegmentOffsets(text, candidate.segments);
          return true;
        } catch {
          return false;
        }
      });
      const cachedSegments = cached
        ? normalizeReviewSegmentOffsets(text, cached.segments)
        : null;
      const cachedModel = cached?.modelResults.find((result) => matchesCachedModel(result, cached));
      if (cached && cachedModel && cachedSegments) {
        await this.prisma.$transaction([
          this.prisma.analysisModelResult.create({
            data: {
              analysisRunId: run.id,
              modelVersionId: cachedModel.modelVersionId,
              modelName: cachedModel.modelName,
              modelVariant: cachedModel.modelVariant,
              rawScore: cachedModel.rawScore,
              calibratedScore: cachedModel.calibratedScore,
              thresholdProfile: cachedModel.thresholdProfile,
              threshold: cachedModel.threshold,
              classification: cachedModel.classification,
              confidence: cachedModel.confidence,
              calibration: cachedModel.calibration,
              preprocessing: cachedModel.preprocessing,
              inferenceMs: 0,
            },
          }),
          this.prisma.analysisSegment.createMany({
            data: cachedSegments.map((segment) => ({
              analysisRunId: run.id,
              paragraphIndex: segment.paragraphIndex,
              textHash: segment.textHash,
              charStart: segment.charStart,
              charEnd: segment.charEnd,
              pageNumber: segment.pageNumber,
              words: segment.words,
              tokens: segment.tokens,
              rawScore: segment.rawScore,
              calibratedScore: segment.calibratedScore,
              classification: segment.classification,
              signalLevel: segment.signalLevel,
              confidence: segment.confidence,
              modelVersionId: segment.modelVersionId,
              modelName: segment.modelName,
            })),
          }),
          this.prisma.analysisRun.update({
            where: { id: run.id },
            data: {
              status: AnalysisRunStatus.COMPLETED,
              threshold: cached.threshold,
              documentAggregation: cached.documentAggregation,
              documentScore: cached.documentScore,
              documentClassification: cached.documentClassification,
              signalLevel: cached.signalLevel,
              scoredSegments: cached.scoredSegments,
              insufficientSegments: cached.insufficientSegments,
              inferenceMs: 0,
              completedAt: new Date(),
              metadata: {
                cacheHit: true,
                cacheKey,
                reusedAnalysisId: cached.id,
                modelId: cachedModel.modelName,
                modelVersion: cachedModel.modelVariant,
                ...(languageCode ? {
                  languageCode,
                  calibrationSource: languageCode === 'es'
                    ? (dto.analyzer === 'F006_1_1_ONLY' ? 'ES_PLATT' : 'ES_ISO')
                    : 'GLOBAL_ISO',
                } : {}),
                ...(asRecord(cached.metadata)?.paragraphContext
                  ? { paragraphContext: asRecord(cached.metadata)?.paragraphContext }
                  : {}),
              } as Prisma.InputJsonValue,
            },
          }),
        ]);
        this.logger.log(JSON.stringify({ event: 'analysis_completed', analysisId: run.id, documentId, model: MODEL_FOR_MODE[dto.analyzer],
          durationMs: Date.now() - started, cacheHit: true }));
        return this.getRun(run.id);
      }
    }
    try {
      const result = await this.ai.analyzeParagraphs({
        text,
        analyzer: dto.analyzer,
        thresholdProfile: dto.thresholdProfile,
        customThreshold: dto.customThreshold,
        paragraphMode: dto.paragraphMode,
        languageCode,
      });
      const normalizedSegments = convertPythonSegmentOffsetsToUtf16(text, result.segments);
      const modelName = MODEL_FOR_MODE[dto.analyzer];
      const modelVersion = await this.prisma.modelVersion.findUnique({ where: { name: modelName } });
      await this.prisma.$transaction([
        this.prisma.analysisModelResult.create({
          data: {
            analysisRunId: run.id,
            modelVersionId: modelVersion?.id ?? null,
            modelName,
            modelVariant: result.modelVersion,
            rawScore: result.rawDocumentScore ?? null,
            calibratedScore: result.documentScore,
            thresholdProfile: result.thresholdProfile,
            threshold: result.threshold,
            classification: (result.documentClassification ?? null) as AnalysisClassification | null,
            confidence: result.documentSignalLevel,
            calibration: result.calibration,
            preprocessing: result.preprocessingVersion,
            inferenceMs: result.inferenceMs,
          },
        }),
        this.prisma.analysisSegment.createMany({
          data: normalizedSegments.map((s: AiAnalyzerSegment) => ({
            analysisRunId: run.id,
            paragraphIndex: s.paragraphIndex,
            textHash: s.textHash,
            charStart: s.charStart,
            charEnd: s.charEnd,
            pageNumber: s.pageNumber,
            words: s.words,
            tokens: s.tokens,
            rawScore: s.rawScore,
            calibratedScore: s.calibratedScore,
            classification: s.classification as AnalysisClassification,
            signalLevel: s.signalLevel,
            confidence: s.confidence,
            modelVersionId: modelVersion?.id ?? null,
            modelName,
          })),
        }),
        this.prisma.analysisRun.update({
          where: { id: run.id },
          data: {
            status: AnalysisRunStatus.COMPLETED,
            threshold: result.threshold,
            documentAggregation: result.documentAggregation,
            documentScore: result.documentScore,
            documentClassification: (result.documentClassification ?? null) as AnalysisClassification | null,
            signalLevel: result.documentSignalLevel,
            scoredSegments: result.scoredParagraphs,
            insufficientSegments: result.insufficientParagraphs,
            inferenceMs: result.inferenceMs,
            completedAt: new Date(),
            metadata: { cacheHit: false, thresholdSource: result.thresholdSource, model: result.model,
              modelId: modelName,
              modelVersion: result.modelVersion,
              ...(languageCode ? {
                languageCode,
                calibrationSource: result.calibrationSource ?? (languageCode === 'es'
                  ? (dto.analyzer === 'F006_1_1_ONLY' ? 'ES_PLATT' : 'ES_ISO')
                  : 'GLOBAL_ISO'),
              } : {}),
              ...(dto.paragraphMode === 'CONTEXTUAL_PARAGRAPH' && result.contextMetadata ? {
                paragraphContext: {
                  ...result.contextMetadata,
                  byParagraph: Object.fromEntries(result.segments.map((segment) => [
                    String(segment.paragraphIndex), segment.contextTokensUsed ?? null,
                  ])),
                },
              } : {}),
              cacheKey: cacheIdentity ? buildAnalysisCacheKey({
                ...cacheIdentity,
                calibrationProfile: cacheCalibrationProfile,
                paragraphMode: dto.paragraphMode,
                textVersionHash: textHash,
                customThreshold: dto.customThreshold,
                granularity: dto.granularity,
                analyzerVersion: ANALYZER_VERSION,
              }) : null } as Prisma.InputJsonValue,
          },
        }),
      ]);
      this.logger.log(JSON.stringify({ event: 'analysis_completed', analysisId: run.id, documentId, model: modelName,
        durationMs: Date.now() - started }));
    } catch (error) {
      const code = (error as { code?: string }).code ?? (error instanceof Error ? error.name : 'UnknownError');
      await this.prisma.analysisRun.update({
        where: { id: run.id },
        data: { status: AnalysisRunStatus.FAILED, errorCode: String(code).slice(0, 80), error: 'analysis failed',
          completedAt: new Date() },
      });
      this.logger.warn(JSON.stringify({ event: 'analysis_failed', analysisId: run.id, documentId, code,
        durationMs: Date.now() - started }));
      throw error;
    }
    return this.getRun(run.id);
  }

  private async cacheIdentity(analyzer: AnalyzerModeName) {
    try {
      const models = (await this.ai.listAnalyzerModels()).models;
      const names = analyzer === 'ENSEMBLE'
        ? ['CANDIDATE_MODEL_V2', 'CANDIDATE_MODEL_V3']
        : [MODEL_FOR_MODE[analyzer]];
      const required = names.map((name) => models.find((model) => model.model === name));
      if (required.some((model) => !model || !model.servable || !model.artifactPresent || !model.artifactValid
        || !['AVAILABLE', 'READY'].includes(model.state))) return null;
      const available = required as AiAnalyzerModelStatus[];
      const versions = available.map((model) => model.modelVersion ?? model.variant);
      const preprocessing = available.map((model) => model.preprocessing.join('+'));
      return {
        modelId: MODEL_FOR_MODE[analyzer],
        modelVersion: versions.join(analyzer === 'ENSEMBLE' ? '+' : ''),
        preprocessingVersion: preprocessing.join(analyzer === 'ENSEMBLE' ? '|' : ''),
      };
    } catch {
      return null;
    }
  }

  async getRun(id: string) {
    const run = await this.prisma.analysisRun.findUnique({
      where: { id },
      include: { modelResults: true, documentVersion: { select: { documentId: true } } },
    });
    if (!run) throw new NotFoundException('Analysis not found');
    const { documentVersion, ...rest } = run;
    return {
      ...rest,
      documentScorePercent: displayPercent(rest.documentScore),
      documentId: documentVersion.documentId,
      spanEvidenceSupported: false,
      spanEvidenceGranularity: 'PARAGRAPH',
      evidenceCapabilities: REVIEW_CAPABILITIES,
      disclaimer: DISCLAIMER,
    };
  }

  async listForDocument(documentId: string) {
    const document = await this.prisma.document.findUnique({ where: { id: documentId }, include: { currentVersion: true } });
    if (!document) throw new NotFoundException('Document not found');
    if (!document.currentVersion) return { items: [] };
    const items = await this.prisma.analysisRun.findMany({
      where: { documentVersionId: document.currentVersion.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { modelResults: true, segments: { select: { classification: true, calibratedScore: true } } },
    });
    return { items: items.map((item) => {
      const { segments: selectedSegments, ...run } = item;
      const segments = selectedSegments ?? [];
      return {
        ...run,
        documentScorePercent: displayPercent(item.documentScore),
        evaluatedSegments: segments.filter(evaluatedSegment).length,
        flaggedSegments: segments.filter((segment) => flaggedSegment(segment, item.threshold)).length,
        spanEvidenceSupported: false,
        spanEvidenceGranularity: 'PARAGRAPH' as const,
        evidenceCapabilities: REVIEW_CAPABILITIES,
      };
    }) };
  }

  /** Segments with their text materialized from the canonical extracted text (not stored twice). */
  async getSegments(id: string, query?: AnalysisSegmentsQueryDto) {
    const run = await this.prisma.analysisRun.findUnique({
      where: { id },
      include: { segments: { orderBy: { paragraphIndex: 'asc' } }, documentVersion: true },
    });
    if (!run) throw new NotFoundException('Analysis not found');
    const text = run.documentVersion.extractedText ?? '';
    const textHashStale = run.textHash !== null && run.textHash !== sha256(text);
    let reviewContext: ReturnType<typeof createReviewDocumentContext> | null = null;
    let reviewSegments: (typeof run.segments[number] & ReviewSegment)[] = run.segments;
    let integrityCode: string | null = null;
    try {
      reviewSegments = normalizeReviewSegmentOffsets(text, reviewSegments).map(segment => ({
        ...segment, ...presentationStructureHint(run.metadata, segment),
      }));
      reviewContext = createReviewDocumentContext(text, reviewSegments);
    } catch (error) {
      if (!(error instanceof ReportReviewIntegrityError)) throw error;
      integrityCode = error.code;
    }
    const stale = textHashStale || reviewContext === null;
    if (query?.includeDocumentText && stale) {
      throw new ConflictException({
        code: integrityCode ?? 'ANALYSIS_TEXT_STALE',
        message: 'El texto de esta versión no coincide con el análisis; no se puede mostrar la revisión.',
      });
    }
    let segments = reviewSegments;
    if (query?.filter && query.filter !== 'ALL') {
      segments = segments.filter((segment) => query.filter === 'INSUFFICIENT'
        ? segment.classification === 'INSUFFICIENT_TEXT'
        : segment.signalLevel === query.filter);
    }
    if (query?.sort === 'SCORE_DESC') {
      segments = [...segments].sort((a, b) =>
        (b.calibratedScore ?? -1) - (a.calibratedScore ?? -1) || a.paragraphIndex - b.paragraphIndex);
    }
    const paginated = query?.page !== undefined || query?.pageSize !== undefined;
    const page = query?.page ?? 1;
    const pageSize = query?.pageSize ?? 20;
    const total = segments.length;
    if (paginated) segments = segments.slice((page - 1) * pageSize, page * pageSize);
    const reviewEvidence = !stale && reviewContext
      ? reviewSegments.map(segment => getReviewEvidence(segment, run.threshold, reviewContext!)) : [];
    return {
      analysisId: run.id,
      ...REVIEW_PRESENTATION_POLICY,
      scientificFlaggedCount: reviewEvidence.filter(segment => segment.flagged).length,
      reviewHighlightedCount: reviewEvidence.filter(segment => segment.reviewHighlighted).length,
      stale,
      spanEvidenceSupported: false,
      spanEvidenceGranularity: 'PARAGRAPH',
      evidenceCapabilities: REVIEW_CAPABILITIES,
      ...(query?.includeDocumentText ? { documentText: text } : {}),
      items: segments.map((s) => ({
        ...s,
        ...presentationStructureHint(run.metadata, s),
        structuralType: presentationStructureHint(run.metadata, s).structuralType ?? (reviewContext ? getReviewStructuralType(s as ReviewSegment, reviewContext) : 'BODY'),
        text: stale ? null : reviewContext?.byParagraphIndex.get(s.paragraphIndex)?.text ?? null,
        reviewPresentation: stale || !reviewContext
          ? { highlight: false, level: null, excludedReason: 'UNSCORED' as const }
          : getReviewPresentation(s as ReviewSegment, reviewContext, run.threshold),
        evidence: stale || !reviewContext
          ? {
              evaluated: false,
              flagged: false,
              reviewHighlighted: false,
              score: s.calibratedScore,
              threshold: run.threshold,
              presentationExcluded: true,
              excludedReason: 'UNSCORED' as const,
              granularity: 'PARAGRAPH' as const,
              paragraphFlagged: false,
              spans: [],
            }
          : getReviewEvidence(s as ReviewSegment, run.threshold, reviewContext),
        ...(run.paragraphMode === 'CONTEXTUAL_PARAGRAPH'
          ? {
              contextTokensBefore: paragraphContextTokenCounts(run.metadata, s.paragraphIndex, 'before'),
              contextTokensAfter: paragraphContextTokenCounts(run.metadata, s.paragraphIndex, 'after'),
            }
          : {}),
      })),
      ...(paginated ? { page, pageSize, total, pages: Math.ceil(total / pageSize) } : {}),
    };
  }

  /** Presentation only: reads canonical segments, never persists groups or invokes AI. */
  async getTechnicalPresentation(id: string) {
    const result = await this.getSegments(id, { includeDocumentText: true });
    const threshold = result.items[0]?.evidence.threshold ?? null;
    const paragraphs: AIReportParagraph[] = result.items.map(segment => ({
      sourceSegmentId: segment.id, paragraphIndex: segment.paragraphIndex, textHash: segment.textHash,
      charStart: segment.charStart, charEnd: segment.charEnd,
      textPreview: segment.text ?? '', score: segment.calibratedScore ?? null,
      classification: segment.classification, signalLevel: segment.signalLevel,
      pageNumber: segment.pageNumber, words: segment.words, tokens: segment.tokens,
      structuralType: segment.structuralType,
      kind: segment.kind ?? undefined, structuralGroupId: segment.structuralGroupId,
      reviewEvidence: segment.evidence, reviewPresentation: segment.reviewPresentation,
      presentationExcluded: segment.evidence.presentationExcluded,
      excludedReason: segment.evidence.excludedReason,
      segmentEvidence: { type: 'PARAGRAPH', paragraphId: segment.paragraphIndex,
        start: segment.charStart, end: segment.charEnd, score: segment.calibratedScore, level: segment.signalLevel },
    }));
    const started = performance.now();
    const heapBefore = process.memoryUsage().heapUsed;
    const presentation = buildTechnicalDisplayUnits(paragraphs, { extractedText: result.documentText ?? '', threshold });
    const groupingMs = performance.now() - started;
    const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
    const references = paragraphs.filter(segment => segment.excludedReason === 'REFERENCE_SECTION');
    this.logger.log(JSON.stringify({ event: 'technical_presentation_built', analysisRunId: id,
      sourceSegments: presentation.audit.sourceSegmentsTotal, displayUnits: presentation.units.length,
      structuralGroups: presentation.counts.structuralGroups, groupingMs: Math.round(groupingMs * 100) / 100 }));
    return {
      analysisRunId: id,
      ...REVIEW_PRESENTATION_POLICY,
      counts: { ...presentation.counts, evaluatedSegments: presentation.counts.evaluated,
        insufficientSegments: presentation.counts.insufficient },
      audit: presentation.audit,
      actionableParagraphIndices: paragraphs.filter(isReviewHighlighted).map(segment => segment.paragraphIndex),
      referenceAudit: { referenceSectionStartSegment: references[0]?.paragraphIndex ?? null,
        referenceSegmentsCount: references.length,
        referenceRawFlagged: references.filter(segment => isTechnicalFlagged(segment, threshold)).length,
        referenceActionableHighlights: references.filter(isReviewHighlighted).length },
      metrics: { groupingMs, heapDeltaBytes },
      displayUnits: presentation.units.map(unit => ({
        id: unit.id, type: unit.type, label: unit.type === 'EVALUATED_SEGMENT' && unit.sourceSegments[0]?.kind === 'PARAGRAPH' ? 'PÁRRAFO' : TECHNICAL_UNIT_LABELS[unit.type],
        sourceSegmentIds: unit.sourceSegmentIds, paragraphIndices: unit.sourceSegmentIds,
        positionStart: unit.positionStart, positionEnd: unit.positionEnd, text: unit.text,
        presentationExcluded: unit.presentationExcluded, excludedReason: unit.excludedReason,
        evaluatedSegments: unit.sourceSegments.filter(isTechnicalEvaluated).map(segment => ({
          sourceSegmentId: segment.sourceSegmentId ?? segment.paragraphIndex,
          paragraphIndex: segment.paragraphIndex, score: segment.score!, threshold,
          flagged: isTechnicalFlagged(segment, threshold), presentationExcluded: isPresentationExcluded(segment),
          reviewHighlighted: isReviewHighlighted(segment),
          excludedReason: segment.excludedReason, text: segment.textPreview,
        })),
      })),
    };
  }

  /** Reconstruct contextual neighbours from the run's own version and stored target offsets. */
  async getSegmentContext(analysisId: string, segmentId: string) {
    const run = await this.prisma.analysisRun.findUnique({
      where: { id: analysisId },
      include: { segments: { orderBy: { paragraphIndex: 'asc' } }, documentVersion: true },
    });
    if (!run) throw new NotFoundException('Analysis not found');
    if (run.status !== AnalysisRunStatus.COMPLETED) {
      throw new ConflictException('Analysis must be completed before showing paragraph context');
    }
    if (run.paragraphMode !== 'CONTEXTUAL_PARAGRAPH') {
      throw new BadRequestException('Paragraph context is only available for contextual analyses');
    }
    const position = run.segments.findIndex((segment) => segment.id === segmentId);
    if (position < 0) throw new NotFoundException('Analysis segment not found');

    const text = run.documentVersion.extractedText ?? '';
    if (run.textHash !== null && run.textHash !== sha256(text)) {
      throw new ConflictException('Analysis text changed after this run');
    }
    const target = run.segments[position]!;
    const materialize = (segment: typeof target) => {
      if (!Number.isSafeInteger(segment.charStart) || !Number.isSafeInteger(segment.charEnd)
        || segment.charStart < 0 || segment.charEnd < segment.charStart || segment.charEnd > text.length) {
        throw new ConflictException('Analysis paragraph offsets are invalid');
      }
      return text.slice(segment.charStart, segment.charEnd);
    };
    const targetText = materialize(target);
    if (sha256(targetText) !== target.textHash) {
      throw new ConflictException('Analysis target offsets no longer match the paragraph');
    }
    const metadata = asRecord(run.metadata);
    const paragraphContext = asRecord(metadata?.paragraphContext);
    const tokenLimitPerSide = paragraphContext?.tokenLimitPerSide;
    const preprocessingProfiles = Array.isArray(paragraphContext?.preprocessingProfiles)
      ? paragraphContext.preprocessingProfiles.filter((profile): profile is string => typeof profile === 'string')
      : [];
    const neighbor = (index: number, side: 'before' | 'after') => {
      const segment = run.segments[index];
      return segment
        ? {
            paragraphIndex: segment.paragraphIndex,
            text: materialize(segment),
            tokensUsed: paragraphContextTokenCounts(run.metadata, target.paragraphIndex, side),
          }
        : { paragraphIndex: null, text: null, tokensUsed: null };
    };
    return {
      analysisId: run.id,
      paragraphMode: run.paragraphMode,
      contextMetadata: {
        tokenLimitPerSide: typeof tokenLimitPerSide === 'number' ? tokenLimitPerSide : null,
        measurement: typeof paragraphContext?.measurement === 'string' ? paragraphContext.measurement : null,
        preprocessingProfiles,
      },
      target: {
        paragraphIndex: target.paragraphIndex,
        charStart: target.charStart,
        charEnd: target.charEnd,
        text: targetText,
      },
      before: neighbor(position - 1, 'before'),
      after: neighbor(position + 1, 'after'),
    };
  }

  async compare(dto: CompareAnalysesDto) {
    if (dto.baseAnalysisId === dto.targetAnalysisId) throw new BadRequestException('Choose two different analyses');
    const load = (id: string) => this.prisma.analysisRun.findUnique({
      where: { id },
      include: { segments: { orderBy: { paragraphIndex: 'asc' } }, documentVersion: true },
    });
    const [base, target] = await Promise.all([load(dto.baseAnalysisId), load(dto.targetAnalysisId)]);
    if (!base || !target) throw new NotFoundException('Analysis not found');
    if (base.status !== AnalysisRunStatus.COMPLETED || target.status !== AnalysisRunStatus.COMPLETED) {
      throw new ConflictException('Both analyses must be completed');
    }
    if (base.analyzerMode !== target.analyzerMode || base.thresholdProfile !== target.thresholdProfile) {
      throw new BadRequestException('Compare analyses made with the same analyzer and threshold profile');
    }
    const aligned = await this.ai.alignVersions(base.documentVersion.extractedText ?? '', target.documentVersion.extractedText ?? '');
    const baseSeg = new Map(base.segments.map((s) => [s.paragraphIndex, s]));
    const targetSeg = new Map(target.segments.map((s) => [s.paragraphIndex, s]));
    const unchangedDrift: number[] = [];
    const paragraphs = aligned.alignment.map((a) => {
      const sa = a.baseParagraphIndex === null ? undefined : baseSeg.get(a.baseParagraphIndex);
      const sb = a.targetParagraphIndex === null ? undefined : targetSeg.get(a.targetParagraphIndex);
      const baseScore = sa?.calibratedScore ?? null;
      const targetScore = sb?.calibratedScore ?? null;
      const delta = baseScore === null || targetScore === null ? null : targetScore - baseScore;
      if (a.status === 'UNCHANGED' && delta !== null) unchangedDrift.push(Math.abs(delta));
      return { ...a, baseScore, targetScore, delta, baseClassification: sa?.classification ?? null,
        targetClassification: sb?.classification ?? null };
    });
    const baseFlagged = new Set(base.segments.filter((segment) => flaggedSegment(segment, base.threshold)).map((segment) => segment.paragraphIndex));
    const targetFlagged = new Set(target.segments.filter((segment) => flaggedSegment(segment, target.threshold)).map((segment) => segment.paragraphIndex));
    let newlyFlagged = 0;
    let noLongerFlagged = 0;
    let stillFlagged = 0;
    for (const paragraph of paragraphs) {
      if (paragraph.status === 'ADDED' && paragraph.targetParagraphIndex !== null) {
        if (targetFlagged.has(paragraph.targetParagraphIndex)) newlyFlagged += 1;
        continue;
      }
      if (paragraph.status === 'REMOVED' && paragraph.baseParagraphIndex !== null) {
        if (baseFlagged.has(paragraph.baseParagraphIndex)) noLongerFlagged += 1;
        continue;
      }
      if (paragraph.baseParagraphIndex === null || paragraph.targetParagraphIndex === null) continue;
      const wasFlagged = baseFlagged.has(paragraph.baseParagraphIndex);
      const isFlagged = targetFlagged.has(paragraph.targetParagraphIndex);
      if (wasFlagged && isFlagged) stillFlagged += 1;
      else if (!wasFlagged && isFlagged) newlyFlagged += 1;
      else if (wasFlagged && !isFlagged) noLongerFlagged += 1;
    }
    const count = (status: string) => paragraphs.filter((p) => p.status === status).length;
    const globalScoreDelta = base.documentScore === null || target.documentScore === null
      ? null : target.documentScore - base.documentScore;
    const details = {
      paragraphs,
      unchangedDrift: driftStats(unchangedDrift),
      analyzerMode: base.analyzerMode,
      thresholdProfile: base.thresholdProfile,
      baseDocumentScore: base.documentScore,
      targetDocumentScore: target.documentScore,
      thresholdReview: {
        previousFlagged: baseFlagged.size,
        currentFlagged: targetFlagged.size,
        newlyFlagged,
        noLongerFlagged,
        stillFlagged,
        baseThreshold: base.threshold,
        targetThreshold: target.threshold,
      },
    };
    const saved = await this.prisma.analysisComparison.create({
      data: {
        baseAnalysisRunId: base.id,
        targetAnalysisRunId: target.id,
        documentSimilarity: aligned.documentSimilarity,
        globalScoreDelta,
        changedSegments: count('MODIFIED'),
        unchangedSegments: count('UNCHANGED'),
        addedSegments: count('ADDED'),
        removedSegments: count('REMOVED'),
        details: details as unknown as Prisma.InputJsonValue,
      },
    });
    return { ...saved, details, disclaimer: DISCLAIMER };
  }
}

export const DISCLAIMER =
  'Estimated AI-involvement signal from an independent research model. It is not a Turnitin score, ' +
  'is not proof of authorship and must not be used alone to make decisions about a person.';
