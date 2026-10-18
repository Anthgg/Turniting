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
import { PrismaService } from '../prisma/prisma.service.js';
import type { AnalysisSegmentsQueryDto, AnalyzeDocumentDto, CompareAnalysesDto } from './dto/analysis.dto.js';

export const ANALYZER_VERSION = 'f005-local-analyzer-v1';
const MODEL_FOR_MODE: Record<string, string> = {
  V2_ONLY: 'CANDIDATE_MODEL_V2',
  V3_ONLY: 'CANDIDATE_MODEL_V3',
  ENSEMBLE: 'ENSEMBLE_V2_V3',
};

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
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
      const cacheKey = sha256([
        textHash,
        cacheIdentity.modelVersion,
        cacheIdentity.preprocessingVersion,
        dto.thresholdProfile,
        dto.customThreshold ?? '',
        dto.granularity,
        dto.paragraphMode,
        ANALYZER_VERSION,
      ].join('\0'));
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
        && (dto.thresholdProfile !== 'CUSTOM' || result.threshold === dto.customThreshold);
      const cached = candidates.find((candidate) =>
        candidate.documentAggregation !== null
        && candidate.documentScore !== null
        && candidate.threshold !== null
        && candidate.modelResults.some((result) => matchesCachedModel(result, candidate)));
      const cachedModel = cached?.modelResults.find((result) => matchesCachedModel(result, cached));
      if (cached && cachedModel) {
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
            data: cached.segments.map((segment) => ({
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
      });
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
          data: result.segments.map((s: AiAnalyzerSegment) => ({
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
              ...(dto.paragraphMode === 'CONTEXTUAL_PARAGRAPH' && result.contextMetadata ? {
                paragraphContext: {
                  ...result.contextMetadata,
                  byParagraph: Object.fromEntries(result.segments.map((segment) => [
                    String(segment.paragraphIndex), segment.contextTokensUsed ?? null,
                  ])),
                },
              } : {}),
              cacheKey: cacheIdentity ? sha256([textHash, cacheIdentity.modelVersion, cacheIdentity.preprocessingVersion,
                dto.thresholdProfile, dto.customThreshold ?? '', dto.granularity, dto.paragraphMode, ANALYZER_VERSION].join('\0')) : null } as Prisma.InputJsonValue,
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
      include: { modelResults: true },
    });
    return { items: items.map((item) => ({
      ...item,
      documentScorePercent: displayPercent(item.documentScore),
    })) };
  }

  /** Segments with their text materialized from the canonical extracted text (not stored twice). */
  async getSegments(id: string, query?: AnalysisSegmentsQueryDto) {
    const run = await this.prisma.analysisRun.findUnique({
      where: { id },
      include: { segments: { orderBy: { paragraphIndex: 'asc' } }, documentVersion: true },
    });
    if (!run) throw new NotFoundException('Analysis not found');
    const text = run.documentVersion.extractedText ?? '';
    const stale = run.textHash !== null && run.textHash !== sha256(text);
    let segments = run.segments;
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
    return {
      analysisId: run.id,
      stale,
      items: segments.map((s) => ({ ...s, text: stale ? null : text.slice(s.charStart, s.charEnd) })),
      ...(paginated ? { page, pageSize, total, pages: Math.ceil(total / pageSize) } : {}),
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
    const count = (status: string) => paragraphs.filter((p) => p.status === status).length;
    const globalScoreDelta = base.documentScore === null || target.documentScore === null
      ? null : target.documentScore - base.documentScore;
    const details = { paragraphs, unchangedDrift: driftStats(unchangedDrift), analyzerMode: base.analyzerMode,
      thresholdProfile: base.thresholdProfile, baseDocumentScore: base.documentScore, targetDocumentScore: target.documentScore };
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
