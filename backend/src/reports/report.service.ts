import {
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  ReportArtifactStatus,
  ReportAuditEventType,
  ReportType,
} from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { REPORT_RENDERER_VERSION, ReportRenderer } from './report-renderer.js';
import type {
  AIReportHistoryItem,
  AIReportInput,
  AIReportParagraph,
} from './report.contracts.js';
import { REPORT_STORAGE, type ReportStorageAdapter } from './report-storage.js';

export const REPORT_RETENTION_HOURS = 24;
const GENERATION_STALE_MS = 10 * 60 * 1000;
const REPORT_RUN_INCLUDE = {
  documentVersion: { include: { document: true } },
  segments: { orderBy: { paragraphIndex: 'asc' } },
  modelResults: { include: { modelVersion: true } },
} satisfies Prisma.AnalysisRunInclude;
type AnalysisRunForReport = Prisma.AnalysisRunGetPayload<{
  include: typeof REPORT_RUN_INCLUDE;
}>;

export interface ReportArtifactMetadata {
  id: string;
  documentId: string;
  documentVersionId: string;
  analysisRunId: string | null;
  similarityRunId: string | null;
  type: ReportType;
  status: ReportArtifactStatus;
  filename: string;
  contentHash: string | null;
  generatedAt: Date;
  expiresAt: Date;
  deletedAt: Date | null;
  downloadEndpoint?: string;
}

@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);
  private readonly retentionMs: number;
  private readonly generationTasks = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly renderer: ReportRenderer,
    @Inject(REPORT_STORAGE) private readonly storage: ReportStorageAdapter,
    config: ConfigService,
  ) {
    const configuredRetention = config
      .get<string>('REPORT_RETENTION_HOURS')
      ?.trim();
    const retentionHours = Number(
      configuredRetention || REPORT_RETENTION_HOURS,
    );
    if (retentionHours !== REPORT_RETENTION_HOURS) {
      throw new Error(
        `REPORT_RETENTION_HOURS must be ${REPORT_RETENTION_HOURS} for F009.0`,
      );
    }
    this.retentionMs = retentionHours * 60 * 60 * 1000;
  }

  async generateAI(
    documentId: string,
    analysisRunId: string,
  ): Promise<ReportArtifactMetadata> {
    const run = await this.prisma.analysisRun.findUnique({
      where: { id: analysisRunId },
      include: REPORT_RUN_INCLUDE,
    });
    if (!run)
      throw new NotFoundException({
        code: 'ANALYSIS_RUN_NOT_FOUND',
        message: 'No existe ese análisis.',
      });
    if (run.documentVersion.documentId !== documentId) {
      throw new NotFoundException({
        code: 'ANALYSIS_RUN_NOT_FOUND',
        message: 'No existe ese análisis para este documento.',
      });
    }
    if (run.status !== 'COMPLETED') {
      throw new ConflictException({
        code: 'ANALYSIS_RUN_NOT_COMPLETED',
        message: 'El análisis debe estar completado para generar el PDF.',
      });
    }

    const extractedText = run.documentVersion.extractedText ?? '';
    if (run.textHash && sha256(extractedText) !== run.textHash) {
      throw new ConflictException({
        code: 'ANALYSIS_TEXT_CHANGED',
        message: 'El texto de esta versión cambió después del análisis.',
      });
    }

    const generatedAt = new Date();
    const input = await this.buildAIInput(run, generatedAt);
    const relevantRunHash = sha256(
      JSON.stringify({
        textHash: run.textHash,
        analyzerMode: run.analyzerMode,
        analyzerVersion: run.analyzerVersion,
        thresholdProfile: run.thresholdProfile,
        threshold: run.threshold,
        paragraphMode: run.paragraphMode,
        documentAggregation: run.documentAggregation,
        documentScore: run.documentScore,
        signalLevel: run.signalLevel,
        metadata: run.metadata,
        modelResults: run.modelResults.map((model) => ({
          modelName: model.modelName,
          modelVariant: model.modelVariant,
          calibratedScore: model.calibratedScore,
          modelVersion: model.modelVersion?.name ?? null,
        })),
        segments: run.segments.map((segment) => ({
          paragraphIndex: segment.paragraphIndex,
          textHash: segment.textHash,
          charStart: segment.charStart,
          charEnd: segment.charEnd,
          calibratedScore: segment.calibratedScore,
          classification: segment.classification,
          signalLevel: segment.signalLevel,
        })),
      }),
    );
    const fingerprint = sha256(
      JSON.stringify([
        run.documentVersionId,
        run.id,
        ReportType.AI_REPORT,
        REPORT_RENDERER_VERSION,
        relevantRunHash,
      ]),
    );

    const reusable = await this.findReusable(fingerprint, generatedAt);
    if (reusable) return this.toMetadata(reusable);

    const reportId = randomUUID();
    const storageKey = `${reportId}.pdf`;
    const artifact = await this.createArtifact({
      id: reportId,
      documentId,
      documentVersionId: run.documentVersionId,
      analysisRunId: run.id,
      type: ReportType.AI_REPORT,
      fingerprint,
      storageKey,
      generatedAt,
      filename: this.filename('ai', documentId, generatedAt),
    });
    if (!artifact) {
      const winner = await this.prisma.reportArtifact.findFirst({
        where: { activeFingerprint: fingerprint },
      });
      if (winner) return this.toMetadata(winner);
      throw new ConflictException(
        'Ya se está generando este reporte. Actualiza el estado en unos instantes.',
      );
    }

    this.scheduleGeneration(reportId, storageKey, input);
    return this.toMetadata(artifact);
  }

  async generateSimilarity(
    documentId: string,
    _similarityRunId: string,
  ): Promise<never> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true },
    });
    if (!document)
      throw new NotFoundException({
        code: 'DOCUMENT_NOT_FOUND',
        message: 'No existe ese documento.',
      });
    throw new ConflictException({
      code: 'SIMILARITY_RUN_UNAVAILABLE',
      message:
        'El reporte de similitud estará disponible cuando exista un SimilarityRun persistido de F008.',
    });
  }

  async listForDocument(
    documentId: string,
  ): Promise<{ items: ReportArtifactMetadata[] }> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true },
    });
    if (!document)
      throw new NotFoundException({
        code: 'DOCUMENT_NOT_FOUND',
        message: 'No existe ese documento.',
      });
    await this.cleanupExpired(new Date(), documentId);
    const rows = await this.prisma.reportArtifact.findMany({
      where: { documentId },
      orderBy: { generatedAt: 'desc' },
      take: 50,
    });
    return { items: rows.map((row) => this.toMetadata(row)) };
  }

  async get(reportId: string): Promise<ReportArtifactMetadata> {
    const artifact = await this.findArtifact(reportId);
    const current = await this.refreshState(artifact, new Date());
    return this.toMetadata(current);
  }

  async download(
    reportId: string,
  ): Promise<{ metadata: ReportArtifactMetadata; buffer: Buffer }> {
    const artifact = await this.findArtifact(reportId);
    const current = await this.refreshState(artifact, new Date());
    if (
      current.status === ReportArtifactStatus.EXPIRED ||
      current.status === ReportArtifactStatus.DELETED
    ) {
      throw new GoneException({
        code: 'REPORT_EXPIRED',
        message:
          'El PDF expiró o fue eliminado. Puedes generarlo nuevamente desde el análisis.',
      });
    }
    if (current.status !== ReportArtifactStatus.AVAILABLE) {
      throw new ConflictException({
        code: 'REPORT_NOT_AVAILABLE',
        message: 'El reporte aún no está disponible para descarga.',
      });
    }
    let buffer: Buffer;
    try {
      buffer = await this.storage.read(current.storageKey);
    } catch {
      await this.markMissing(current.id);
      throw new GoneException({
        code: 'REPORT_FILE_UNAVAILABLE',
        message:
          'El archivo ya no está disponible. Puedes generar un nuevo reporte.',
      });
    }
    await this.prisma.reportAuditEvent.create({
      data: {
        reportArtifactId: current.id,
        type: ReportAuditEventType.REPORT_DOWNLOADED,
      },
    });
    return { metadata: this.toMetadata(current), buffer };
  }

  async delete(reportId: string): Promise<void> {
    const artifact = await this.findArtifact(reportId);
    if (artifact.deletedAt) return;
    await this.storage.delete(artifact.storageKey);
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.reportArtifact.updateMany({
        where: { id: reportId, deletedAt: null },
        data: {
          status: ReportArtifactStatus.DELETED,
          deletedAt: new Date(),
          activeFingerprint: null,
        },
      });
      if (changed.count > 0) {
        await tx.reportAuditEvent.create({
          data: {
            reportArtifactId: reportId,
            type: ReportAuditEventType.REPORT_DELETED,
          },
        });
      }
    });
  }

  async cleanupExpired(now = new Date(), documentId?: string): Promise<number> {
    const artifacts = await this.prisma.reportArtifact.findMany({
      where: {
        expiresAt: { lte: now },
        deletedAt: null,
        ...(documentId ? { documentId } : {}),
      },
      orderBy: { expiresAt: 'asc' },
    });
    let expired = 0;
    for (const artifact of artifacts) {
      try {
        await this.storage.delete(artifact.storageKey);
        const count = await this.prisma.$transaction(async (tx) => {
          const changed = await tx.reportArtifact.updateMany({
            where: {
              id: artifact.id,
              expiresAt: { lte: now },
              deletedAt: null,
            },
            data: {
              status: ReportArtifactStatus.EXPIRED,
              deletedAt: now,
              activeFingerprint: null,
            },
          });
          if (changed.count > 0) {
            await tx.reportAuditEvent.create({
              data: {
                reportArtifactId: artifact.id,
                type: ReportAuditEventType.REPORT_EXPIRED,
              },
            });
          }
          return changed.count;
        });
        expired += count;
      } catch {
        this.logger.warn(
          JSON.stringify({
            event: 'report_cleanup_failed',
            reportId: artifact.id,
          }),
        );
      }
    }
    const staleBefore = new Date(now.getTime() - GENERATION_STALE_MS);
    const staleArtifacts = await this.prisma.reportArtifact.findMany({
      where: {
        status: ReportArtifactStatus.GENERATING,
        createdAt: { lte: staleBefore },
        deletedAt: null,
        ...(documentId ? { documentId } : {}),
      },
    });
    for (const artifact of staleArtifacts) {
      await this.markStaleGeneration(artifact.id, artifact.storageKey);
    }
    return expired;
  }

  private async buildAIInput(
    fullRun: AnalysisRunForReport,
    generatedAt: Date,
  ): Promise<Omit<AIReportInput, 'reportId'>> {
    const extractedText = fullRun.documentVersion.extractedText ?? '';
    const paragraphs: AIReportParagraph[] = fullRun.segments.map((segment) => ({
      paragraphIndex: segment.paragraphIndex,
      score: segment.calibratedScore,
      signalLevel: segment.signalLevel,
      classification: segment.classification,
      textPreview: extractedText.slice(
        Math.max(0, segment.charStart),
        Math.min(extractedText.length, segment.charEnd),
      ),
      pageNumber: segment.pageNumber,
      words: segment.words,
      tokens: segment.tokens,
    }));
    const modelNames = [
      ...new Set(fullRun.modelResults.map((model) => model.modelName)),
    ];
    const modelVersions = [
      ...new Set(
        fullRun.modelResults
          .map((model) => model.modelVersion?.name ?? model.modelVariant)
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    const historyRows = await this.prisma.analysisRun.findMany({
      where: {
        documentVersionId: fullRun.documentVersion.id,
        status: 'COMPLETED',
        id: { not: fullRun.id },
      },
      orderBy: { completedAt: 'desc' },
      take: 7,
      include: { modelResults: true },
    });
    const history: AIReportHistoryItem[] = historyRows.map((item) => ({
      id: item.id,
      createdAt: item.completedAt ?? item.createdAt,
      model:
        [...new Set(item.modelResults.map((model) => model.modelName))].join(
          ' + ',
        ) || item.analyzerMode,
      paragraphMode: item.paragraphMode,
      score: item.documentScore,
    }));
    const limitations = [
      ...new Set(
        fullRun.modelResults.flatMap(
          (model) => model.modelVersion?.limitations ?? [],
        ),
      ),
    ];
    const metadata =
      fullRun.metadata &&
      typeof fullRun.metadata === 'object' &&
      !Array.isArray(fullRun.metadata)
        ? (fullRun.metadata as Record<string, unknown>)
        : {};

    return {
      generatedAt,
      turnitingVersion: process.env.npm_package_version ?? 'local',
      document: {
        id: fullRun.documentVersion.document.id,
        filename: fullRun.documentVersion.document.originalName,
        createdAt: fullRun.documentVersion.document.createdAt,
        updatedAt: fullRun.documentVersion.document.updatedAt,
      },
      run: {
        id: fullRun.id,
        status: fullRun.status,
        analyzerMode: fullRun.analyzerMode,
        analyzerVersion: fullRun.analyzerVersion,
        thresholdProfile: fullRun.thresholdProfile,
        threshold: fullRun.threshold,
        paragraphMode: fullRun.paragraphMode,
        documentAggregation: fullRun.documentAggregation,
        documentScore: fullRun.documentScore,
        signalLevel: fullRun.signalLevel,
        scoredSegments: fullRun.scoredSegments,
        insufficientSegments: fullRun.insufficientSegments,
        inferenceMs: fullRun.inferenceMs,
        cacheHit: metadata.cacheHit === true,
        metadata: fullRun.metadata,
        createdAt: fullRun.createdAt,
        completedAt: fullRun.completedAt,
        modelNames,
        modelVersions,
      },
      paragraphs,
      history,
      limitations,
    };
  }

  private async findReusable(fingerprint: string, now: Date) {
    const artifact = await this.prisma.reportArtifact.findFirst({
      where: { activeFingerprint: fingerprint },
    });
    if (!artifact) return null;
    if (artifact.expiresAt <= now) {
      await this.cleanupExpired(now, artifact.documentId);
      return null;
    }
    if (artifact.status === ReportArtifactStatus.AVAILABLE) {
      if (await this.storage.exists(artifact.storageKey)) return artifact;
      await this.markMissing(artifact.id);
      return null;
    }
    if (
      artifact.status === ReportArtifactStatus.GENERATING &&
      now.getTime() - artifact.createdAt.getTime() < GENERATION_STALE_MS
    ) {
      return artifact;
    }
    await this.markStaleGeneration(artifact.id, artifact.storageKey);
    return null;
  }

  private async createArtifact(data: {
    id: string;
    documentId: string;
    documentVersionId: string;
    analysisRunId: string;
    type: ReportType;
    fingerprint: string;
    storageKey: string;
    generatedAt: Date;
    filename: string;
  }) {
    try {
      return await this.prisma.reportArtifact.create({
        data: {
          ...data,
          status: ReportArtifactStatus.GENERATING,
          activeFingerprint: data.fingerprint,
          generationVersion: REPORT_RENDERER_VERSION,
          expiresAt: new Date(data.generatedAt.getTime() + this.retentionMs),
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        return null;
      throw error;
    }
  }

  private async findArtifact(reportId: string) {
    const artifact = await this.prisma.reportArtifact.findUnique({
      where: { id: reportId },
    });
    if (!artifact)
      throw new NotFoundException({
        code: 'REPORT_NOT_FOUND',
        message: 'No existe ese reporte.',
      });
    return artifact;
  }

  private scheduleGeneration(
    reportId: string,
    storageKey: string,
    input: Omit<AIReportInput, 'reportId'>,
  ): void {
    if (this.generationTasks.has(reportId)) return;
    const task = new Promise<void>((resolve) => {
      setImmediate(() => {
        void this.finishGeneration(reportId, storageKey, input).finally(
          resolve,
        );
      });
    });
    this.generationTasks.set(reportId, task);
    void task.finally(() => this.generationTasks.delete(reportId));
  }

  private async finishGeneration(
    reportId: string,
    storageKey: string,
    input: Omit<AIReportInput, 'reportId'>,
  ): Promise<void> {
    try {
      const buffer = await this.renderer.renderAI({ ...input, reportId });
      await this.storage.save(storageKey, buffer);
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.reportArtifact.updateMany({
          where: { id: reportId, status: ReportArtifactStatus.GENERATING },
          data: {
            status: ReportArtifactStatus.AVAILABLE,
            contentHash: sha256(buffer),
          },
        });
        if (changed.count === 0) {
          throw new Error('report_generation_no_longer_active');
        }
        await tx.reportAuditEvent.create({
          data: {
            reportArtifactId: reportId,
            type: ReportAuditEventType.REPORT_GENERATED,
          },
        });
      });
    } catch {
      await this.storage.delete(storageKey).catch(() => false);
      await this.prisma.reportArtifact
        .updateMany({
          where: { id: reportId, status: ReportArtifactStatus.GENERATING },
          data: { status: ReportArtifactStatus.ERROR, activeFingerprint: null },
        })
        .catch(() => undefined);
      this.logger.error(
        JSON.stringify({
          event: 'report_generation_failed',
          reportId,
          type: ReportType.AI_REPORT,
        }),
      );
    }
  }

  private async refreshState(
    artifact: Awaited<ReturnType<ReportService['findArtifact']>>,
    now: Date,
  ) {
    if (artifact.deletedAt) return artifact;
    if (artifact.expiresAt <= now) {
      await this.cleanupExpired(now, artifact.documentId);
      return this.findArtifact(artifact.id);
    }
    if (
      artifact.status === ReportArtifactStatus.AVAILABLE &&
      !(await this.storage.exists(artifact.storageKey))
    ) {
      await this.markMissing(artifact.id);
      return this.findArtifact(artifact.id);
    }
    if (
      artifact.status === ReportArtifactStatus.GENERATING &&
      now.getTime() - artifact.createdAt.getTime() >= GENERATION_STALE_MS
    ) {
      await this.markStaleGeneration(artifact.id, artifact.storageKey);
      return this.findArtifact(artifact.id);
    }
    return artifact;
  }

  private async markStaleGeneration(
    reportId: string,
    storageKey: string,
  ): Promise<void> {
    await this.storage.delete(storageKey).catch(() => false);
    await this.prisma.reportArtifact.updateMany({
      where: { id: reportId, status: ReportArtifactStatus.GENERATING },
      data: { status: ReportArtifactStatus.ERROR, activeFingerprint: null },
    });
  }

  private async markMissing(reportId: string): Promise<void> {
    await this.prisma.reportArtifact.updateMany({
      where: {
        id: reportId,
        status: ReportArtifactStatus.AVAILABLE,
        deletedAt: null,
      },
      data: { status: ReportArtifactStatus.ERROR, activeFingerprint: null },
    });
  }

  private filename(
    kind: 'ai' | 'similarity',
    documentId: string,
    date: Date,
  ): string {
    const day = date.toISOString().slice(0, 10);
    return `turniting_${kind}_${documentId.slice(0, 8)}_${day}.pdf`;
  }

  private toMetadata(artifact: {
    id: string;
    documentId: string;
    documentVersionId: string;
    analysisRunId: string | null;
    similarityRunId: string | null;
    type: ReportType;
    status: ReportArtifactStatus;
    filename: string;
    contentHash: string | null;
    generatedAt: Date;
    expiresAt: Date;
    deletedAt: Date | null;
  }): ReportArtifactMetadata {
    return {
      id: artifact.id,
      documentId: artifact.documentId,
      documentVersionId: artifact.documentVersionId,
      analysisRunId: artifact.analysisRunId,
      similarityRunId: artifact.similarityRunId,
      type: artifact.type,
      status: artifact.status,
      filename: artifact.filename,
      contentHash: artifact.contentHash,
      generatedAt: artifact.generatedAt,
      expiresAt: artifact.expiresAt,
      deletedAt: artifact.deletedAt,
      ...(artifact.status === ReportArtifactStatus.AVAILABLE
        ? { downloadEndpoint: `/api/reports/${artifact.id}/download` }
        : {}),
    };
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
