import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AnalysisClassification, AnalysisRunStatus, AnalyzerMode, Prisma } from '@prisma/client';
import { AiService, type AiAnalyzerSegment } from '../ai/ai.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AnalyzeDocumentDto, CompareAnalysesDto } from './dto/analysis.dto.js';

export const ANALYZER_VERSION = 'f005-local-analyzer-v1';
const MODEL_FOR_MODE: Record<string, string> = {
  V2_ONLY: 'CANDIDATE_MODEL_V2',
  V3_ONLY: 'CANDIDATE_MODEL_V3',
  ENSEMBLE: 'ENSEMBLE_V2_V3',
};

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
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

    const run = await this.prisma.analysisRun.create({
      data: {
        documentVersionId: version.id,
        status: AnalysisRunStatus.RUNNING,
        analyzerMode: dto.analyzer as AnalyzerMode,
        analyzerVersion: ANALYZER_VERSION,
        thresholdProfile: dto.thresholdProfile,
        granularity: dto.granularity,
        paragraphMode: dto.paragraphMode,
        textHash: sha256(text),
      },
    });
    const started = Date.now();
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
            rawScore: result.documentScore,
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
            metadata: { thresholdSource: result.thresholdSource, model: result.model } as Prisma.InputJsonValue,
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

  async getRun(id: string) {
    const run = await this.prisma.analysisRun.findUnique({
      where: { id },
      include: { modelResults: true, documentVersion: { select: { documentId: true } } },
    });
    if (!run) throw new NotFoundException('Analysis not found');
    const { documentVersion, ...rest } = run;
    return { ...rest, documentId: documentVersion.documentId, disclaimer: DISCLAIMER };
  }

  async listForDocument(documentId: string) {
    const document = await this.prisma.document.findUnique({ where: { id: documentId }, include: { currentVersion: true } });
    if (!document) throw new NotFoundException('Document not found');
    if (!document.currentVersion) return { items: [] };
    const items = await this.prisma.analysisRun.findMany({
      where: { documentVersionId: document.currentVersion.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return { items };
  }

  /** Segments with their text materialized from the canonical extracted text (not stored twice). */
  async getSegments(id: string) {
    const run = await this.prisma.analysisRun.findUnique({
      where: { id },
      include: { segments: { orderBy: { paragraphIndex: 'asc' } }, documentVersion: true },
    });
    if (!run) throw new NotFoundException('Analysis not found');
    const text = run.documentVersion.extractedText ?? '';
    const stale = run.textHash !== null && run.textHash !== sha256(text);
    return {
      analysisId: run.id,
      stale,
      items: run.segments.map((s) => ({ ...s, text: stale ? null : text.slice(s.charStart, s.charEnd) })),
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
