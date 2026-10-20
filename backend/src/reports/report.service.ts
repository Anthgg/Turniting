import {
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  ReportArtifactStatus,
  ReportAuditEventType,
  ReportType,
} from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import {
  createReviewDocumentContext,
  getReviewEvidence,
  getReviewPresentation,
  normalizeReviewSegmentOffsets,
  ReportReviewIntegrityError,
  type ReviewSegment,
} from '../analysis/review-presentation.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { REPORT_RENDERER_VERSION, SIMILARITY_RENDERER_VERSION, ReportRenderer } from './report-renderer.js';
import type {
  AIReportHistoryItem,
  AIReportInput,
  AIReportParagraph,
} from './report.contracts.js';
import { REPORT_STORAGE, type ReportStorageAdapter } from './report-storage.js';
import { OriginalDocumentRenderer } from './original-document-renderer.js';
import { resolveAnalysisSource, type ResolvedAnalysisSource } from './analysis-source.js';
import { stampTurnitingReport } from './report-pdf-metadata.js';
import {
  AI_ORIGINAL_REVIEW_RENDERER_VERSION,
  AI_PARAGRAPH_TECHNICAL_RENDERER_VERSION,
  REPORT_RETENTION_HOURS,
} from './report.constants.js';

export { REPORT_RETENTION_HOURS } from './report.constants.js';

const GENERATION_STALE_MS = 10 * 60 * 1000;
const REPORT_RUN_INCLUDE = {
  documentVersion: { include: { document: true } },
  segments: { orderBy: { paragraphIndex: 'asc' } },
  modelResults: { include: { modelVersion: true } },
} satisfies Prisma.AnalysisRunInclude;
type AnalysisRunForReport = Prisma.AnalysisRunGetPayload<{
  include: typeof REPORT_RUN_INCLUDE;
}>;
type PreparedAIReport = {
  run: AnalysisRunForReport;
  source: ResolvedAnalysisSource;
  generatedAt: Date;
  input: Omit<AIReportInput, 'reportId'>;
};

export interface ReportArtifactMetadata {
  id: string;
  reportId: string;
  documentId: string;
  documentVersionId: string;
  analysisRunId: string | null;
  similarityRunId: string | null;
  type: ReportType;
  variant: ReportType;
  generatedBy: string;
  sourceArtifactType: 'DOCUMENT_VERSION';
  sourceDocumentId: string;
  sourceDocumentVersionId: string;
  sourceChecksum: string | null;
  analysisSnapshot?: unknown;
  run?: ReportArtifactDetail['run'];
  status: ReportArtifactStatus;
  filename: string;
  documentName?: string;
  runLabel?: string;
  contentHash: string | null;
  sizeBytes: number | null;
  failureReason: string | null;
  generationVersion: string;
  rendererVersion: string;
  generatedAt: Date;
  createdAt: Date;
  expiresAt: Date;
  deletedAt: Date | null;
  reused?: boolean;
  downloadEndpoint?: string;
  previewEndpoint?: string;
  downloadAvailable: boolean;
  previewAvailable: boolean;
}

export interface ReportListQuery {
  documentId?: string;
  type?: ReportType;
  status?: ReportArtifactStatus;
  page?: number;
  pageSize?: number;
}

export interface ReportCleanupMetrics {
  expiredCount: number;
  deletedFiles: number;
  missingFiles: number;
  failedDeletes: number;
  renderArtifactsExpired: number;
  layoutMapsExpired: number;
}

export interface ReportArtifactDetail extends ReportArtifactMetadata {
  documentName: string;
  run: {
    id: string;
    analyzerMode: string;
    analyzerVersion: string;
    modelNames: string[];
    thresholdProfile: string;
    threshold: number | null;
    paragraphMode: string | null;
    globalScore: number | null;
  } | null;
}

const GENERIC_FAILURE_REASON = 'No se pudo generar el PDF. Intenta de nuevo.';

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
    @Optional() private readonly originalRenderer?: OriginalDocumentRenderer,
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
    regeneratedFromId?: string,
    variant: ReportType = ReportType.AI_REPORT,
  ): Promise<ReportArtifactMetadata> {
    const prepared = await this.prepareAIReport(documentId, analysisRunId);
    return this.generatePreparedAI(prepared, regeneratedFromId, variant);
  }

  async generateBothAI(documentId: string, analysisRunId: string) {
    // Resolve once. Both artifacts receive exactly the same source and run snapshot.
    const prepared = await this.prepareAIReport(documentId, analysisRunId);
    const originalReview = await this.generatePreparedAI(prepared, undefined, ReportType.AI_ORIGINAL_REVIEW);
    const paragraphTechnical = await this.generatePreparedAI(prepared, undefined, ReportType.AI_PARAGRAPH_TECHNICAL);
    return { originalReview, paragraphTechnical };
  }

  private async prepareAIReport(documentId: string, analysisRunId: string): Promise<PreparedAIReport> {
    if (!analysisRunId) {
      throw new ConflictException({ code: 'ANALYSIS_RUN_REQUIRED', message: 'Selecciona el análisis exacto para generar sus reportes.' });
    }
    const run = await this.prisma.analysisRun.findUnique({
      where: { id: analysisRunId },
      include: REPORT_RUN_INCLUDE,
    });
    if (!run || run.documentVersion.documentId !== documentId) {
      throw new NotFoundException({ code: 'ANALYSIS_RUN_NOT_FOUND', message: 'No existe ese análisis para este documento.' });
    }
    if (run.status !== 'COMPLETED') {
      throw new ConflictException({ code: 'ANALYSIS_RUN_NOT_COMPLETED', message: 'El análisis debe estar completado para generar el PDF.' });
    }
    let source: ResolvedAnalysisSource;
    try {
      source = resolveAnalysisSource(run);
    } catch (error) {
      this.logger.warn(JSON.stringify({ event: 'report_source_integrity_violation', analysisRunId: run.id, documentId, documentVersionId: run.documentVersionId }));
      throw error;
    }
    const extractedText = run.documentVersion.extractedText ?? '';
    if (run.textHash && sha256(extractedText) !== run.textHash) {
      throw new ConflictException({ code: 'ANALYSIS_TEXT_CHANGED', message: 'El texto de esta versión cambió después del análisis.' });
    }
    const generatedAt = new Date();
    const input = await this.buildAIInput(run, generatedAt, source);
    return { run, source, generatedAt, input };
  }

  private async generatePreparedAI(
    prepared: PreparedAIReport,
    regeneratedFromId: string | undefined,
    variant: ReportType,
  ): Promise<ReportArtifactMetadata> {
    if (
      variant !== ReportType.AI_REPORT &&
      variant !== ReportType.AI_ORIGINAL_REVIEW &&
      variant !== ReportType.AI_PARAGRAPH_TECHNICAL
    ) {
      throw new ConflictException({
        code: 'AI_REPORT_VARIANT_UNSUPPORTED',
        message: 'La variante solicitada no corresponde a un reporte de IA.',
      });
    }
    const { run, source, generatedAt, input } = prepared;
    const documentId = source.documentId;
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
        source.documentVersionId,
        source.sourceChecksum,
        run.id,
        variant,
        rendererVersionFor(variant),
        relevantRunHash,
      ]),
    );

    if (regeneratedFromId) {
      // A requested regeneration creates a new artifact while preserving earlier PDFs and metadata.
      await this.prisma.reportArtifact.updateMany({
        where: { analysisRunId: run.id, type: variant, activeFingerprint: fingerprint },
        data: { activeFingerprint: null },
      });
    }
    const reusable = regeneratedFromId ? null : await this.findReusable(fingerprint, generatedAt);
    if (reusable) {
      await this.prisma.reportAuditEvent.create({
        data: {
          reportArtifactId: reusable.id,
          type: ReportAuditEventType.REPORT_REUSED,
        },
      });
      return this.toMetadata(reusable, { reused: true });
    }

    const reportId = randomUUID();
    const storageKey = `${reportId}.pdf`;
    const artifact = await this.createArtifact({
      id: reportId,
      documentId,
      documentVersionId: run.documentVersionId,
      analysisRunId: run.id,
      sourceDocumentId: source.documentId,
      sourceDocumentVersionId: source.documentVersionId,
      sourceChecksum: source.sourceChecksum,
      analysisSnapshot: reportSnapshot(input, run),
      type: variant,
      fingerprint,
      storageKey,
      generatedAt,
      filename: this.filename(filenameKindFor(variant), documentId, generatedAt, source.originalFilename),
    });
    if (!artifact) {
      const winner = await this.prisma.reportArtifact.findFirst({
        where: { activeFingerprint: fingerprint },
      });
      if (winner) {
        await this.prisma.reportAuditEvent.create({
          data: {
            reportArtifactId: winner.id,
            type: ReportAuditEventType.REPORT_REUSED,
          },
        });
        return this.toMetadata(winner, { reused: true });
      }
      throw new ConflictException(
        'Ya se está generando este reporte. Actualiza el estado en unos instantes.',
      );
    }

    if (regeneratedFromId) {
      await this.prisma.reportAuditEvent.create({
        data: {
          reportArtifactId: artifact.id,
          type: ReportAuditEventType.REPORT_REGENERATED,
          metadata: { previousReportId: regeneratedFromId },
        },
      });
    }
    this.logger.log(JSON.stringify({ event: 'report_source_resolved', reportId, reportVariant: variant, analysisRunId: run.id, documentId: source.documentId, documentVersionId: source.documentVersionId, sourceArtifactType: source.sourceArtifactType, sourceChecksumPrefix: source.sourceChecksum.slice(0, 12) }));
    this.scheduleGeneration(reportId, storageKey, input, variant);
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
    query: ReportListQuery = {},
  ): Promise<{
    items: ReportArtifactMetadata[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true },
    });
    if (!document)
      throw new NotFoundException({
        code: 'DOCUMENT_NOT_FOUND',
        message: 'No existe ese documento.',
      });
    return this.list({ ...query, documentId });
  }

  async list(query: ReportListQuery = {}): Promise<{
    items: ReportArtifactMetadata[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize ?? 20)));
    const now = new Date();
    await this.cleanupExpired(now, query.documentId);
    const where: Prisma.ReportArtifactWhereInput = {
      ...(query.documentId ? { documentId: query.documentId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.reportArtifact.findMany({
        where,
        include: {
          document: { select: { originalName: true } },
          documentVersion: { select: { originalFilename: true } },
          analysisRun: {
            select: {
              id: true,
              analyzerMode: true,
              analyzerVersion: true,
              thresholdProfile: true,
              threshold: true,
              paragraphMode: true,
              documentScore: true,
              modelResults: { select: { modelName: true } },
            },
          },
        },
        orderBy: { generatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.reportArtifact.count({ where }),
    ]);
    const refreshedRows = await Promise.all(
      rows.map((row) => this.refreshState(row, now)),
    );
    if (
      query.status &&
      refreshedRows.some((row, index) => row.status !== rows[index].status)
    ) {
      return this.list(query);
    }
    return {
      items: refreshedRows.map((row, index) => ({
        ...this.toMetadata(row),
        documentName:
          snapshotDocumentName(row.analysisSnapshot) ??
          rows[index].documentVersion?.originalFilename ??
          rows[index].document?.originalName ??
          `Documento ${row.documentId.slice(0, 8)}`,
        run: snapshotRun(row.analysisSnapshot) ?? runSummary(rows[index].analysisRun),
        runLabel: rows[index].analysisRun
          ? `${rows[index].analysisRun.id.slice(0, 8)} · ${rows[index].analysisRun.analyzerMode}`
          : row.analysisRunId?.slice(0, 8) ?? '—',
      })),
      total,
      page,
      pageSize,
    };
  }

  async get(reportId: string): Promise<ReportArtifactDetail> {
    const artifact = await this.findArtifact(reportId);
    const current = await this.refreshState(artifact, new Date());
    const [document, run] = await Promise.all([
      this.prisma.document.findUnique({
        where: { id: current.documentId },
        select: { originalName: true },
      }),
      current.analysisRunId
        ? this.prisma.analysisRun.findUnique({
            where: { id: current.analysisRunId },
            select: {
              id: true,
              analyzerMode: true,
              analyzerVersion: true,
              thresholdProfile: true,
              threshold: true,
              paragraphMode: true,
              documentScore: true,
              modelResults: { select: { modelName: true } },
            },
          })
        : Promise.resolve(null),
    ]);
    return {
      ...this.toMetadata(current),
      documentName: snapshotDocumentName(current.analysisSnapshot) ?? document?.originalName ?? 'Documento no disponible',
      run: snapshotRun(current.analysisSnapshot) ?? (run
        ? {
            id: run.id,
            analyzerMode: run.analyzerMode,
            analyzerVersion: run.analyzerVersion,
            modelNames: [...new Set(run.modelResults.map((item) => item.modelName))],
            thresholdProfile: run.thresholdProfile,
            threshold: run.threshold,
            paragraphMode: run.paragraphMode,
            globalScore: run.documentScore,
          }
        : null),
    };
  }

  async regenerate(reportId: string): Promise<ReportArtifactMetadata> {
    const artifact = await this.findArtifact(reportId);
    const current = await this.refreshState(artifact, new Date());
    if (!isAIReportType(current.type) || !current.analysisRunId) {
      throw new ConflictException({
        code: 'REPORT_REGENERATION_UNAVAILABLE',
        message: 'Solo se pueden regenerar reportes de IA con su corrida original.',
      });
    }
    if (
      current.status === ReportArtifactStatus.GENERATING
    ) {
      throw new ConflictException({
        code: 'REPORT_REGENERATION_UNAVAILABLE',
        message: 'Espera a que termine la generación actual.',
      });
    }
    const prepared = await this.prepareAIReport(current.documentId, current.analysisRunId);
    if (current.documentVersionId !== prepared.source.documentVersionId ||
      current.sourceDocumentVersionId !== prepared.source.documentVersionId ||
      current.sourceDocumentId !== prepared.source.documentId ||
      current.sourceChecksum !== prepared.source.sourceChecksum) {
      this.logger.warn(JSON.stringify({ event: 'report_source_integrity_violation', reportId, analysisRunId: current.analysisRunId, documentId: current.documentId, documentVersionId: current.documentVersionId }));
      throw new ConflictException({ code: 'ANALYSIS_SOURCE_INTEGRITY_INVALID', message: 'El reporte no conserva la fuente de su análisis original.' });
    }
    return this.generatePreparedAI(prepared, current.id, current.type);
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

  async preview(
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
        message: 'El PDF expiró o fue eliminado. Puedes regenerarlo desde el análisis.',
      });
    }
    if (current.status !== ReportArtifactStatus.AVAILABLE) {
      throw new ConflictException({
        code: 'REPORT_NOT_AVAILABLE',
        message: 'El reporte todavía no está disponible para vista previa.',
      });
    }
    try {
      return {
        metadata: this.toMetadata(current),
        buffer: await this.storage.read(current.storageKey),
      };
    } catch {
      await this.markMissing(current.id);
      throw new GoneException({
        code: 'REPORT_FILE_UNAVAILABLE',
        message: 'El archivo ya no está disponible. Puedes generar un nuevo reporte.',
      });
    }
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

  async cleanupExpired(
    now = new Date(),
    documentId?: string,
  ): Promise<ReportCleanupMetrics> {
    const artifacts = await this.prisma.reportArtifact.findMany({
      where: {
        expiresAt: { lte: now },
        deletedAt: null,
        ...(documentId ? { documentId } : {}),
      },
      orderBy: { expiresAt: 'asc' },
    });
    const metrics: ReportCleanupMetrics = {
      expiredCount: 0,
      deletedFiles: 0,
      missingFiles: 0,
      failedDeletes: 0,
      renderArtifactsExpired: 0,
      layoutMapsExpired: 0,
    };
    for (const artifact of artifacts) {
      let fileDeleted: boolean;
      try {
        fileDeleted = await this.storage.delete(artifact.storageKey);
        if (fileDeleted) metrics.deletedFiles += 1;
        else metrics.missingFiles += 1;
      } catch {
        metrics.failedDeletes += 1;
        continue;
      }
      try {
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
        metrics.expiredCount += count;
      } catch {
        this.logger.warn(
          JSON.stringify({
            event: 'report_cleanup_metadata_failed',
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

    const expiredRenders = await this.prisma.originalRenderArtifact.findMany({
      where: {
        expiresAt: { lte: now },
        deletedAt: null,
        ...(documentId ? { documentId } : {}),
      },
      orderBy: { expiresAt: 'asc' },
    });
    for (const artifact of expiredRenders) {
      try {
        const deleted = await this.storage.delete(artifact.storageKey);
        if (deleted) metrics.deletedFiles += 1;
        else metrics.missingFiles += 1;
      } catch {
        metrics.failedDeletes += 1;
        continue;
      }
      const changed = await this.prisma.originalRenderArtifact.updateMany({
        where: {
          id: artifact.id,
          expiresAt: { lte: now },
          deletedAt: null,
        },
        data: { deletedAt: now, layoutPages: [] },
      });
      metrics.renderArtifactsExpired += changed.count;
    }

    const expiredMaps = await this.prisma.documentLayoutMap.updateMany({
      where: {
        expiresAt: { lte: now },
        deletedAt: null,
        ...(documentId ? { documentId } : {}),
      },
      data: {
        deletedAt: now,
        layoutMap: { version: 'expired', pages: [], segments: [] },
      },
    });
    metrics.layoutMapsExpired = expiredMaps.count;
    return metrics;
  }

  private async buildAIInput(
    fullRun: AnalysisRunForReport,
    generatedAt: Date,
    source: ResolvedAnalysisSource,
  ): Promise<Omit<AIReportInput, 'reportId'>> {
    const extractedText = fullRun.documentVersion.extractedText ?? '';
    let normalizedSegments = fullRun.segments;
    let reviewContext: ReturnType<typeof createReviewDocumentContext>;
    try {
      normalizedSegments = normalizeReviewSegmentOffsets(
        extractedText,
        fullRun.segments,
      );
      reviewContext = createReviewDocumentContext(
        extractedText,
        normalizedSegments,
      );
    } catch (error) {
      if (error instanceof ReportReviewIntegrityError) {
        throw new ConflictException({
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }
    const paragraphs: AIReportParagraph[] = normalizedSegments.map((segment) => {
      const verified = reviewContext.byParagraphIndex.get(segment.paragraphIndex);
      if (!verified) {
        throw new ConflictException({
          code: 'ANALYSIS_SEGMENT_OFFSETS_INVALID',
          message: 'El texto de esta versión no coincide con el análisis.',
        });
      }
      const sourceSegment = segment as typeof segment & { evidence?: unknown };
      const evidence = getReviewEvidence({
        ...segment,
        calibratedScore: segment.calibratedScore,
        evidence: sourceSegment.evidence,
      } as ReviewSegment, fullRun.threshold, reviewContext);
      const reviewPresentation = getReviewPresentation(
        { ...segment, calibratedScore: segment.calibratedScore } as ReviewSegment,
        reviewContext,
        fullRun.threshold,
      );
      return {
        paragraphIndex: segment.paragraphIndex,
        textHash: segment.textHash,
        charStart: segment.charStart,
        charEnd: segment.charEnd,
        segmentEvidence: {
          type: evidence.granularity,
          paragraphId: segment.paragraphIndex,
          start: segment.charStart,
          end: segment.charEnd,
          score: segment.calibratedScore,
          level: segment.signalLevel,
          ...(evidence.spans.length ? { spans: evidence.spans } : {}),
        },
        reviewEvidence: evidence,
        reviewPresentation,
        presentationExcluded: Boolean(reviewPresentation.excludedReason),
        excludedReason: reviewPresentation.excludedReason ?? null,
        score: segment.calibratedScore,
        signalLevel: segment.signalLevel,
        classification: segment.classification,
        textPreview: verified.text,
        pageNumber: segment.pageNumber,
        words: segment.words,
        tokens: segment.tokens,
      };
    });
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
        id: source.documentId,
        documentVersionId: source.documentVersionId,
        filename: source.originalFilename,
        mimeType: source.mimeType,
        sourceChecksum: source.sourceChecksum,
        storageKey: source.sourceStorageObject.storageKey,
        createdAt: fullRun.documentVersion.document.createdAt,
        updatedAt: fullRun.documentVersion.document.updatedAt,
      },
      extractedText,
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
    sourceDocumentId: string;
    sourceDocumentVersionId: string;
    sourceChecksum: string;
    analysisSnapshot: Prisma.InputJsonValue;
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
          generatedBy: 'TURNITING',
          status: ReportArtifactStatus.GENERATING,
          activeFingerprint: data.fingerprint,
          generationVersion: rendererVersionFor(data.type),
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
    type: ReportType,
  ): void {
    if (this.generationTasks.has(reportId)) return;
    const task = new Promise<void>((resolve) => {
      setImmediate(() => {
        void this.finishGeneration(reportId, storageKey, input, type).finally(
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
    type: ReportType,
  ): Promise<void> {
    try {
      let buffer: Buffer;
      const reportInput = { ...input, reportId };
      if (type === ReportType.AI_ORIGINAL_REVIEW) {
        if (!this.originalRenderer) {
          throw new Error('Original document renderer is not configured');
        }
        const original = await this.originalRenderer.ensure({
          sourceArtifactType: 'DOCUMENT_VERSION',
          documentId: input.document.id,
          documentVersionId: input.document.documentVersionId,
          analysisRunId: input.run.id,
          storageKey: input.document.storageKey,
          sourceChecksum: input.document.sourceChecksum,
          originalName: input.document.filename,
          mimeType: input.document.mimeType,
          segments: input.paragraphs.map((paragraph) => ({
            paragraphIndex: paragraph.paragraphIndex,
            textHash: paragraph.textHash,
            charStart: paragraph.charStart,
            charEnd: paragraph.charEnd,
            text: paragraph.textPreview,
            flagged:
              input.run.threshold !== null &&
              paragraph.score !== null &&
              paragraph.score >= input.run.threshold,
            presentationExcluded: Boolean(
              paragraph.presentationExcluded ||
                paragraph.reviewPresentation.excludedReason,
            ),
          })),
        });
        buffer = await this.originalRenderer.renderOriginalReview(
          reportInput,
          original,
        );
      } else if (type === ReportType.AI_PARAGRAPH_TECHNICAL) {
        buffer = await this.renderer.renderAIParagraphTechnical(reportInput);
      } else {
        buffer = await this.renderer.renderAI(reportInput);
      }
      if (type === ReportType.AI_ORIGINAL_REVIEW || type === ReportType.AI_PARAGRAPH_TECHNICAL) {
        buffer = await stampTurnitingReport(buffer, { reportId, reportVariant: type, analysisRunId: input.run.id, sourceDocumentId: input.document.id, sourceDocumentVersionId: input.document.documentVersionId, rendererVersion: rendererVersionFor(type) });
      }
      await this.storage.save(storageKey, buffer);
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.reportArtifact.updateMany({
          where: { id: reportId, status: ReportArtifactStatus.GENERATING },
          data: {
            status: ReportArtifactStatus.AVAILABLE,
            contentHash: sha256(buffer),
            sizeBytes: buffer.length,
            failureReason: null,
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
      await this.prisma
        .$transaction(async (tx) => {
          const changed = await tx.reportArtifact.updateMany({
            where: { id: reportId, status: ReportArtifactStatus.GENERATING },
            data: {
              status: ReportArtifactStatus.FAILED,
              activeFingerprint: null,
              failureReason: GENERIC_FAILURE_REASON,
            },
          });
          if (changed.count > 0) {
            await tx.reportAuditEvent.create({
              data: {
                reportArtifactId: reportId,
                type: ReportAuditEventType.REPORT_FAILED,
              },
            });
          }
        })
        .catch(() => undefined);
      this.logger.error(
        JSON.stringify({
          event: 'report_generation_failed',
          reportId,
          type,
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
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.reportArtifact.updateMany({
        where: { id: reportId, status: ReportArtifactStatus.GENERATING },
        data: {
          status: ReportArtifactStatus.FAILED,
          activeFingerprint: null,
          failureReason: GENERIC_FAILURE_REASON,
        },
      });
      if (changed.count > 0) {
        await tx.reportAuditEvent.create({
          data: {
            reportArtifactId: reportId,
            type: ReportAuditEventType.REPORT_FAILED,
          },
        });
      }
    });
  }

  private async markMissing(reportId: string): Promise<void> {
    const changed = await this.prisma.reportArtifact.updateMany({
      where: {
        id: reportId,
        status: ReportArtifactStatus.AVAILABLE,
        deletedAt: null,
      },
      data: {
        status: ReportArtifactStatus.FAILED,
        activeFingerprint: null,
        failureReason: GENERIC_FAILURE_REASON,
      },
    });
    if (changed.count > 0) {
      await this.prisma.reportAuditEvent.create({
        data: {
          reportArtifactId: reportId,
          type: ReportAuditEventType.REPORT_FAILED,
        },
      });
    }
  }

  private filename(
    kind: 'ai' | 'similarity' | 'original-review' | 'paragraph-technical',
    documentId: string,
    date: Date,
    originalFilename: string,
  ): string {
    const day = date.toISOString().slice(0, 10);
    const name = originalFilename.replace(/\.[^.]+$/u, '').normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').replace(/[^A-Za-z0-9_-]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 64) || 'documento';
    return `turniting_${kind}_${name}_${documentId.slice(0, 8)}_${day}.pdf`;
  }

  private toMetadata(artifact: {
    id: string;
    documentId: string;
    documentVersionId: string;
    analysisRunId: string | null;
    similarityRunId: string | null;
    type: ReportType;
    generatedBy?: string;
    sourceDocumentId?: string;
    sourceDocumentVersionId?: string;
    sourceChecksum?: string;
    analysisSnapshot?: unknown;
    status: ReportArtifactStatus;
    filename: string;
    contentHash: string | null;
    sizeBytes?: number | null;
    failureReason?: string | null;
    generationVersion?: string;
    generatedAt: Date;
    createdAt?: Date;
    expiresAt: Date;
    deletedAt: Date | null;
  }, options: { reused?: boolean } = {}): ReportArtifactMetadata {
    const status =
      artifact.status === ReportArtifactStatus.ERROR
        ? ReportArtifactStatus.FAILED
        : artifact.status;
    return {
      id: artifact.id,
      reportId: artifact.id,
      documentId: artifact.documentId,
      documentVersionId: artifact.documentVersionId,
      analysisRunId: artifact.analysisRunId,
      similarityRunId: artifact.similarityRunId,
      type: artifact.type,
      variant: artifact.type,
      generatedBy: artifact.generatedBy ?? 'TURNITING',
      sourceArtifactType: 'DOCUMENT_VERSION',
      sourceDocumentId: artifact.sourceDocumentId ?? artifact.documentId,
      sourceDocumentVersionId: artifact.sourceDocumentVersionId ?? artifact.documentVersionId,
      sourceChecksum: artifact.sourceChecksum ?? null,
      ...(artifact.analysisSnapshot ? { analysisSnapshot: artifact.analysisSnapshot, run: snapshotRun(artifact.analysisSnapshot) } : {}),
      ...(snapshotDocumentName(artifact.analysisSnapshot) ? { documentName: snapshotDocumentName(artifact.analysisSnapshot) } : {}),
      status,
      filename: artifact.filename,
      contentHash: artifact.contentHash,
      sizeBytes: artifact.sizeBytes ?? null,
      failureReason:
        artifact.failureReason ??
        (artifact.status === ReportArtifactStatus.ERROR
          ? GENERIC_FAILURE_REASON
          : null),
      generationVersion:
        artifact.generationVersion ?? rendererVersionFor(artifact.type),
      rendererVersion:
        artifact.generationVersion ?? rendererVersionFor(artifact.type),
      generatedAt: artifact.generatedAt,
      createdAt: artifact.createdAt ?? artifact.generatedAt,
      expiresAt: artifact.expiresAt,
      deletedAt: artifact.deletedAt,
      ...(options.reused ? { reused: true } : {}),
      downloadAvailable: status === ReportArtifactStatus.AVAILABLE,
      previewAvailable: status === ReportArtifactStatus.AVAILABLE,
      ...(status === ReportArtifactStatus.AVAILABLE
        ? {
            downloadEndpoint: `/api/reports/${artifact.id}/download`,
            previewEndpoint: `/api/reports/${artifact.id}/preview`,
          }
        : {}),
    };
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function reportSnapshot(input: Omit<AIReportInput, 'reportId'>, run: AnalysisRunForReport): Prisma.InputJsonValue {
  return {
    version: 'f00941-analysis-source-v1',
    source: {
      sourceArtifactType: 'DOCUMENT_VERSION',
      documentId: input.document.id,
      documentVersionId: input.document.documentVersionId,
      originalFilename: input.document.filename,
      mimeType: input.document.mimeType,
      sourceChecksum: input.document.sourceChecksum,
    },
    run: {
      id: input.run.id,
      analyzerMode: input.run.analyzerMode,
      analyzerVersion: input.run.analyzerVersion,
      modelId: input.run.modelNames.join(' + ') || input.run.analyzerVersion,
      modelNames: input.run.modelNames,
      modelVersions: input.run.modelVersions,
      thresholdProfile: input.run.thresholdProfile,
      threshold: input.run.threshold,
      paragraphMode: input.run.paragraphMode,
      globalScore: input.run.documentScore,
      documentAggregation: input.run.documentAggregation,
      segmentCount: input.paragraphs.length,
      flaggedCount: input.paragraphs.filter(p => p.score !== null && input.run.threshold !== null && p.score >= input.run.threshold && !p.presentationExcluded).length,
      insufficientSegments: input.run.insufficientSegments,
      calibration: run.modelResults.map(model => ({ modelName: model.modelName, modelVersion: model.modelVersion?.name ?? model.modelVariant ?? null, calibration: model.calibration ?? null })),
    },
  };
}

function snapshotRun(value: unknown): ReportArtifactDetail['run'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const run = (value as { run?: unknown }).run;
  if (!run || typeof run !== 'object' || Array.isArray(run) || typeof (run as { id?: unknown }).id !== 'string') return undefined;
  return run as NonNullable<ReportArtifactDetail['run']>;
}

function snapshotDocumentName(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const name = (value as { source?: { originalFilename?: unknown } }).source?.originalFilename;
  return typeof name === 'string' ? name : undefined;
}

function runSummary(run: { id: string; analyzerMode: string; analyzerVersion: string; thresholdProfile: string; threshold: number | null; paragraphMode: string | null; documentScore: number | null; modelResults: Array<{ modelName: string }> } | null): ReportArtifactDetail['run'] {
  return run ? { id: run.id, analyzerMode: run.analyzerMode, analyzerVersion: run.analyzerVersion, modelNames: [...new Set(run.modelResults.map(m => m.modelName))], thresholdProfile: run.thresholdProfile, threshold: run.threshold, paragraphMode: run.paragraphMode, globalScore: run.documentScore } : null;
}

function isAIReportType(type: ReportType): boolean {
  return (
    type === ReportType.AI_REPORT ||
    type === ReportType.AI_ORIGINAL_REVIEW ||
    type === ReportType.AI_PARAGRAPH_TECHNICAL
  );
}

function rendererVersionFor(type: ReportType): string {
  if (type === ReportType.AI_ORIGINAL_REVIEW) {
    return AI_ORIGINAL_REVIEW_RENDERER_VERSION;
  }
  if (type === ReportType.AI_PARAGRAPH_TECHNICAL) {
    return AI_PARAGRAPH_TECHNICAL_RENDERER_VERSION;
  }
  return type === ReportType.AI_REPORT
    ? REPORT_RENDERER_VERSION
    : SIMILARITY_RENDERER_VERSION;
}

function filenameKindFor(
  type: ReportType,
): 'ai' | 'original-review' | 'paragraph-technical' {
  if (type === ReportType.AI_ORIGINAL_REVIEW) return 'original-review';
  if (type === ReportType.AI_PARAGRAPH_TECHNICAL) {
    return 'paragraph-technical';
  }
  return 'ai';
}
