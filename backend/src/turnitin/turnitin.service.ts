import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GroundTruthCaseType,
  Prisma,
  TurnitinMatchStatus,
  TurnitinReportStatus,
  TurnitinReportType,
  TurnitinSourceType,
  TurnitinSubmissionRelation,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  AiService,
  type AiTurnitinAlignmentResponse,
  type AiTurnitinParseResponse,
} from '../ai/ai.service.js';
import {
  type BufferedUpload,
  validateDocumentFile,
} from '../documents/file-validation.js';
import { StorageService } from '../documents/storage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  CreateGroundTruthCaseDto,
  ListTurnitinReportsQueryDto,
  ListTurnitinSegmentsQueryDto,
  UpdateGroundTruthCaseDto,
} from './dto/turnitin.dto.js';

const PARSER_VERSION = 'f002-v1';
const PARSE_FAILURE_WARNING =
  'The report parser was unavailable. The file is saved and can be reparsed.';

type ReportWithCounts = Prisma.TurnitinReportGetPayload<{
  include: {
    _count: { select: { sources: true; segments: true } };
    documentVersion: {
      select: { id: true; document: { select: { id: true; originalName: true } } };
    };
  };
}>;
type ReportRecord = Prisma.TurnitinReportGetPayload<{}>;

@Injectable()
export class TurnitinService {
  private readonly logger = new Logger(TurnitinService.name);
  private readonly maxUploadBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly ai: AiService,
    config: ConfigService,
  ) {
    this.maxUploadBytes =
      config.getOrThrow<number>('MAX_TURNITIN_REPORT_MB') * 1024 * 1024;
  }

  async upload(file?: BufferedUpload) {
    const upload = validateDocumentFile(file, this.maxUploadBytes);
    if (upload.fileType !== 'pdf') {
      throw new UnsupportedMediaTypeException({
        code: 'INVALID_REPORT_TYPE',
        message: 'Only PDF Turnitin reports are supported',
      });
    }

    const fileHash = createHash('sha256').update(upload.buffer).digest('hex');
    let storageKey: string;
    try {
      storageKey = await this.storage.saveTurnitinReport(upload.buffer);
    } catch (error) {
      this.logError('turnitin_report_storage_failed', error);
      throw new InternalServerErrorException('Turnitin report could not be saved');
    }

    let parsed: AiTurnitinParseResponse | undefined;
    try {
      parsed = await this.ai.parseTurnitinReport({
        buffer: upload.buffer,
        mimeType: upload.mimeType,
        originalName: upload.originalName,
      });
    } catch (error) {
      this.logError('turnitin_report_parse_failed', error);
    }

    let reportId: string | undefined;
    try {
      await this.prisma.$transaction(async (transaction) => {
        const report = await transaction.turnitinReport.create({
          data: {
            originalName: upload.originalName,
            mimeType: upload.mimeType,
            size: upload.size,
            fileHash,
            storageKey,
            ...(parsed
              ? this.parsedReportFields(parsed)
              : {
                  reportType: TurnitinReportType.UNKNOWN,
                  status: TurnitinReportStatus.FAILED,
                  parserVersion: PARSER_VERSION,
                  warnings: [PARSE_FAILURE_WARNING],
                }),
          },
        });
        reportId = report.id;
        if (parsed) await this.createRelatedRows(transaction, report.id, parsed);
      });
    } catch (error) {
      await this.cleanupStoredFile(storageKey, 'turnitin_report_create_rollback_failed');
      this.logError('turnitin_report_persist_failed', error);
      throw new InternalServerErrorException('Turnitin report could not be saved');
    }
    if (!reportId) throw new InternalServerErrorException('Turnitin report could not be saved');
    return this.getById(reportId);
  }

  async list(query: ListTurnitinReportsQueryDto) {
    const skip = (query.page - 1) * query.limit;
    const where: Prisma.TurnitinReportWhereInput = {
      ...(query.reportType ? { reportType: query.reportType } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [reports, total] = await Promise.all([
      this.prisma.turnitinReport.findMany({
        where,
        skip,
        take: query.limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: reportSummaryInclude,
      }),
      this.prisma.turnitinReport.count({ where }),
    ]);
    return {
      items: reports.map((report) => this.reportDto(report)),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async getById(id: string) {
    const report = await this.prisma.turnitinReport.findUnique({
      where: { id },
      include: reportSummaryInclude,
    });
    if (!report) throw new NotFoundException('Turnitin report not found');
    return this.reportDto(report);
  }

  async getSources(id: string, page: number, limit: number) {
    await this.requireReport(id);
    const where = { reportId: id };
    const [items, total] = await Promise.all([
      this.prisma.turnitinSource.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { sourceIndex: 'asc' },
      }),
      this.prisma.turnitinSource.count({ where }),
    ]);
    return { items, page, limit, total, totalPages: Math.ceil(total / limit) };
  }

  async getSegments(
    id: string,
    query: ListTurnitinSegmentsQueryDto,
  ) {
    await this.requireReport(id);
    const where: Prisma.TurnitinSegmentWhereInput = {
      reportId: id,
      ...(query.segmentType ? { segmentType: query.segmentType } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.turnitinSegment.findMany({
        where,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        orderBy: { segmentIndex: 'asc' },
        include: {
          source: {
            select: {
              id: true,
              sourceIndex: true,
              sourceType: true,
              displayName: true,
              percentageRaw: true,
            },
          },
        },
      }),
      this.prisma.turnitinSegment.count({ where }),
    ]);
    return {
      items,
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async reparse(id: string) {
    const report = await this.requireReport(id);
    const buffer = await this.readStoredReport(report.storageKey);
    const parsed = await this.parseStoredReport(report.originalName, buffer);
    const alignment = report.documentVersionId
      ? await this.alignToVersion(report.documentVersionId, parsed)
      : undefined;

    const updated = await this.prisma.$transaction(async (transaction) => {
      await transaction.turnitinSegment.deleteMany({ where: { reportId: id } });
      await transaction.turnitinSource.deleteMany({ where: { reportId: id } });
      const saved = await transaction.turnitinReport.update({
        where: { id },
        data: {
          ...this.parsedReportFields(parsed),
          ...(alignment
            ? {
                contentMatchStatus: alignment.matchStatus,
                contentSimilarityRatio: alignment.similarityRatio,
                contentMatchEvidence: asJson(alignment.signals),
                matchedAt: new Date(),
              }
            : {
                contentMatchStatus: TurnitinMatchStatus.UNVERIFIED,
                contentSimilarityRatio: null,
                contentMatchEvidence: Prisma.JsonNull,
                matchedAt: null,
              }),
        },
      });
      await this.createRelatedRows(transaction, id, parsed, alignment);
      return transaction.turnitinReport.findUniqueOrThrow({
        where: { id: saved.id },
        include: reportSummaryInclude,
      });
    });
    return this.reportDto(updated);
  }

  async match(id: string, documentVersionId: string) {
    const report = await this.requireReport(id);
    const version = await this.prisma.documentVersion.findUnique({
      where: { id: documentVersionId },
      include: { document: { select: { originalName: true } } },
    });
    if (!version) throw new NotFoundException('Document version not found');
    if (version.extractedText === null) {
      throw new ConflictException({
        code: 'DOCUMENT_TEXT_NOT_AVAILABLE',
        message: 'The selected document version has no extracted text',
      });
    }

    const buffer = await this.readStoredReport(report.storageKey);
    const parsed = await this.parseStoredReport(report.originalName, buffer);
    const alignment = await this.ai.alignTurnitinReport(
      version.extractedText,
      parsed.documentText,
      parsed.segments.map(({ segmentIndex, text }) => ({ segmentIndex, text })),
      {
        originalName: version.document.originalName,
        wordCount: version.wordCount,
        characterCount: version.characterCount,
      },
      parsed.metadata,
    );
    const updated = await this.prisma.$transaction(async (transaction) => {
      await transaction.turnitinReport.update({
        where: { id },
        data: {
          documentVersionId,
          contentMatchStatus: alignment.matchStatus,
          contentSimilarityRatio: alignment.similarityRatio,
          contentMatchEvidence: asJson(alignment.signals),
          matchedAt: new Date(),
          submissionRelation: TurnitinSubmissionRelation.UNKNOWN,
        },
      });
      await this.updateSegmentAlignments(transaction, id, alignment);
      return transaction.turnitinReport.findUniqueOrThrow({
        where: { id },
        include: reportSummaryInclude,
      });
    });
    return this.reportDto(updated);
  }

  async remove(id: string) {
    const report = await this.requireReport(id);
    await this.prisma.turnitinReport.delete({ where: { id } });
    await this.cleanupStoredFile(report.storageKey, 'turnitin_report_storage_cleanup_failed');
    return { status: 'deleted', id };
  }

  async createGroundTruthCase(input: CreateGroundTruthCaseDto) {
    this.validateGroundTruthReferences(input);
    const [aiReport, similarityReport, documentVersion] = await Promise.all([
      input.aiReportId ? this.requireReport(input.aiReportId) : null,
      input.similarityReportId ? this.requireReport(input.similarityReportId) : null,
      input.documentVersionId
        ? this.prisma.documentVersion.findUnique({
            where: { id: input.documentVersionId },
          })
        : null,
    ]);
    if (input.documentVersionId && !documentVersion) {
      throw new NotFoundException('Document version not found');
    }
    if (aiReport && aiReport.reportType !== TurnitinReportType.AI_WRITING) {
      throw new BadRequestException({
        code: 'INVALID_REPORT_TYPE',
        message: 'The AI ground truth reference must be an AI-writing report',
      });
    }
    if (similarityReport && similarityReport.reportType !== TurnitinReportType.SIMILARITY) {
      throw new BadRequestException({
        code: 'INVALID_REPORT_TYPE',
        message: 'The similarity ground truth reference must be a similarity report',
      });
    }

    const actualData = await this.groundTruthActualData(
      aiReport,
      similarityReport,
      documentVersion,
    );
    const submissionRelation = this.submissionRelation(aiReport, similarityReport);
    const contentMatchStatus = this.contentMatchStatus(aiReport, similarityReport);
    const validationStatus = validateExpectedData(input.expectedData, actualData);
    try {
      return await this.prisma.groundTruthCase.create({
        data: {
          name: input.name,
          caseType: input.caseType,
          aiReportId: input.aiReportId,
          similarityReportId: input.similarityReportId,
          documentVersionId: input.documentVersionId,
          submissionRelation,
          contentMatchStatus,
          validationStatus,
          expectedData: input.expectedData
            ? asJson(input.expectedData)
            : Prisma.JsonNull,
          actualData: asJson(actualData),
          notes: input.notes,
        },
      });
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new ConflictException('A ground truth case with that name already exists');
      }
      throw error;
    }
  }

  async listGroundTruthCases(page = 1, limit = 20) {
    const [items, total] = await Promise.all([
      this.prisma.groundTruthCase.findMany({
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.groundTruthCase.count(),
    ]);
    return { items, page, limit, total, totalPages: Math.ceil(total / limit) };
  }

  async getGroundTruthCase(id: string) {
    const result = await this.prisma.groundTruthCase.findUnique({ where: { id } });
    if (!result) {
      throw new NotFoundException({
        code: 'GROUND_TRUTH_CASE_NOT_FOUND',
        message: 'Ground truth case not found',
      });
    }
    return result;
  }

  async updateGroundTruthCase(id: string, input: UpdateGroundTruthCaseDto) {
    const existing = await this.getGroundTruthCase(id);
    const [aiReport, similarityReport, documentVersion] = await Promise.all([
      existing.aiReportId ? this.requireReport(existing.aiReportId) : null,
      existing.similarityReportId
        ? this.requireReport(existing.similarityReportId)
        : null,
      existing.documentVersionId
        ? this.prisma.documentVersion.findUnique({
            where: { id: existing.documentVersionId },
          })
        : null,
    ]);
    const actualData = await this.groundTruthActualData(
      aiReport,
      similarityReport,
      documentVersion,
    );
    const expectedData =
      input.expectedData ?? asPlainObject(existing.expectedData);
    return this.prisma.groundTruthCase.update({
      where: { id },
      data: {
        ...(input.expectedData ? { expectedData: asJson(input.expectedData) } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        actualData: asJson(actualData),
        validationStatus: validateExpectedData(expectedData, actualData),
        contentMatchStatus: this.contentMatchStatus(aiReport, similarityReport),
        submissionRelation: this.submissionRelation(aiReport, similarityReport),
      },
    });
  }

  private async parseStoredReport(
    originalName: string,
    buffer: Buffer,
  ): Promise<AiTurnitinParseResponse> {
    try {
      return await this.ai.parseTurnitinReport({
        buffer,
        mimeType: 'application/pdf',
        originalName,
      });
    } catch (error) {
      this.logError('turnitin_report_reparse_failed', error);
      throw new ServiceUnavailableException({
        code: 'TURNITIN_REPORT_PARSE_FAILED',
        message: 'The report could not be parsed. Existing parsed data was preserved.',
      });
    }
  }

  private async alignToVersion(
    documentVersionId: string,
    parsed: AiTurnitinParseResponse,
  ): Promise<AiTurnitinAlignmentResponse | undefined> {
    const version = await this.prisma.documentVersion.findUnique({
      where: { id: documentVersionId },
      include: { document: { select: { originalName: true } } },
    });
    if (!version?.extractedText) return undefined;
    return this.ai.alignTurnitinReport(
      version.extractedText,
      parsed.documentText,
      parsed.segments.map(({ segmentIndex, text }) => ({ segmentIndex, text })),
      {
        originalName: version.document.originalName,
        wordCount: version.wordCount,
        characterCount: version.characterCount,
      },
      parsed.metadata,
    );
  }

  private async createRelatedRows(
    transaction: Prisma.TransactionClient,
    reportId: string,
    parsed: AiTurnitinParseResponse,
    alignment?: AiTurnitinAlignmentResponse,
  ): Promise<void> {
    const sources = new Map<number, string>();
    for (const source of parsed.sources) {
      const created = await transaction.turnitinSource.create({
        data: {
          reportId,
          sourceIndex: source.sourceIndex,
          sourceType: source.sourceType as TurnitinSourceType,
          displayName: source.displayName,
          percentageRaw: source.percentageRaw,
          percentage: source.percentage,
          percentageIsLessThan: source.percentageIsLessThan,
          color: source.color,
        },
        select: { id: true, sourceIndex: true },
      });
      sources.set(created.sourceIndex, created.id);
    }
    const alignments = new Map(
      alignment?.segmentAlignments.map((item) => [item.segmentIndex, item]) ?? [],
    );
    if (parsed.segments.length) {
      await transaction.turnitinSegment.createMany({
        data: parsed.segments.map((segment) => {
          const matched = alignments.get(segment.segmentIndex);
          return {
            reportId,
            sourceId:
              segment.sourceIndex === null
                ? null
                : (sources.get(segment.sourceIndex) ?? null),
            segmentIndex: segment.segmentIndex,
            segmentType: segment.segmentType,
            pageNumber: segment.pageNumber,
            text: segment.text,
            normalizedText: segment.normalizedText,
            bbox: asJson(segment.bbox),
            sourceIndex: segment.sourceIndex,
            color: segment.color,
            documentStartOffset: matched?.documentStartOffset,
            documentEndOffset: matched?.documentEndOffset,
            alignmentMethod: matched?.alignmentMethod,
            alignmentScore: matched?.alignmentScore,
          };
        }),
      });
    }
  }

  private async updateSegmentAlignments(
    transaction: Prisma.TransactionClient,
    reportId: string,
    alignment: AiTurnitinAlignmentResponse,
  ): Promise<void> {
    await Promise.all(
      alignment.segmentAlignments.map((item) =>
        transaction.turnitinSegment.updateMany({
          where: { reportId, segmentIndex: item.segmentIndex },
          data: {
            documentStartOffset: item.documentStartOffset,
            documentEndOffset: item.documentEndOffset,
            alignmentMethod: item.alignmentMethod,
            alignmentScore: item.alignmentScore,
          },
        }),
      ),
    );
  }

  private parsedReportFields(parsed: AiTurnitinParseResponse) {
    const scores = parsed.scores;
    return {
      reportType: parsed.reportType as TurnitinReportType,
      status: parsed.status as TurnitinReportStatus,
      parserVersion: parsed.parserVersion || PARSER_VERSION,
      submissionId: stringValue(parsed.metadata.submissionId),
      submissionFileName: stringValue(parsed.metadata.submissionFileName),
      submittedAt: dateValue(parsed.metadata.submittedAt),
      reportPageCount: numberValue(parsed.metadata.reportPageCount),
      documentPageCount: numberValue(parsed.metadata.documentPageCount),
      wordCount: numberValue(parsed.metadata.wordCount),
      characterCount: numberValue(parsed.metadata.characterCount),
      aiWritingScore: scores.aiWriting?.percentage ?? null,
      aiWritingScoreRaw: scores.aiWriting?.raw ?? null,
      similarityScore: scores.similarity?.percentage ?? null,
      similarityScoreRaw: scores.similarity?.raw ?? null,
      internetScore: scores.internet?.percentage ?? null,
      internetScoreRaw: scores.internet?.raw ?? null,
      publicationScore: scores.publications?.percentage ?? null,
      publicationScoreRaw: scores.publications?.raw ?? null,
      studentPapersScore: scores.studentPapers?.percentage ?? null,
      studentPapersScoreRaw: scores.studentPapers?.raw ?? null,
      filters: parsed.filters,
      warnings: parsed.warnings,
      reportMetadata: asJson(parsed.metadata),
      requiresOcr: parsed.status === 'OCR_REQUIRED',
    };
  }

  private reportDto(report: ReportWithCounts) {
    return {
      id: report.id,
      originalName: report.originalName,
      mimeType: report.mimeType,
      sizeBytes: report.size,
      sha256: report.fileHash,
      reportType: report.reportType,
      status: report.status,
      parserVersion: report.parserVersion,
      submissionId: report.submissionId,
      submissionFileName: report.submissionFileName,
      submittedAt: report.submittedAt,
      downloadedAt: report.downloadedAt,
      requiresOcr: report.requiresOcr,
      reportPageCount: report.reportPageCount,
      documentPageCount: report.documentPageCount,
      wordCount: report.wordCount,
      characterCount: report.characterCount,
      scores: {
        aiWriting: { raw: report.aiWritingScoreRaw, percentage: report.aiWritingScore },
        similarity: { raw: report.similarityScoreRaw, percentage: report.similarityScore },
        internet: { raw: report.internetScoreRaw, percentage: report.internetScore },
        publications: { raw: report.publicationScoreRaw, percentage: report.publicationScore },
        studentPapers: {
          raw: report.studentPapersScoreRaw,
          percentage: report.studentPapersScore,
        },
      },
      filters: report.filters,
      warnings: report.warnings,
      reportMetadata: report.reportMetadata,
      documentVersionId: report.documentVersionId,
      documentId: report.documentVersion?.document.id ?? null,
      documentName: report.documentVersion?.document.originalName ?? null,
      contentMatchStatus: report.contentMatchStatus,
      submissionRelation: report.submissionRelation,
      contentSimilarityRatio: report.contentSimilarityRatio,
      contentMatchEvidence: report.contentMatchEvidence,
      sourceCount: report._count.sources,
      segmentCount: report._count.segments,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
      matchedAt: report.matchedAt,
    };
  }

  private async requireReport(id: string) {
    const report = await this.prisma.turnitinReport.findUnique({ where: { id } });
    if (!report) {
      throw new NotFoundException({
        code: 'TURNITIN_REPORT_NOT_FOUND',
        message: 'Turnitin report not found',
      });
    }
    return report;
  }

  private async readStoredReport(storageKey: string): Promise<Buffer> {
    try {
      if (!(await this.storage.exists(storageKey))) throw new Error('Missing stored report');
      return await this.storage.read(storageKey);
    } catch (error) {
      this.logError('turnitin_report_storage_read_failed', error);
      throw new ServiceUnavailableException('Turnitin report file is unavailable');
    }
  }

  private async cleanupStoredFile(storageKey: string, event: string) {
    try {
      await this.storage.delete(storageKey);
    } catch (error) {
      this.logError(event, error);
    }
  }

  private validateGroundTruthReferences(input: CreateGroundTruthCaseDto): void {
    if (input.caseType === GroundTruthCaseType.AI_REPORT && !input.aiReportId) {
      throw new BadRequestException('AI_REPORT cases require aiReportId');
    }
    if (
      input.caseType === GroundTruthCaseType.SIMILARITY_REPORT &&
      !input.similarityReportId
    ) {
      throw new BadRequestException('SIMILARITY_REPORT cases require similarityReportId');
    }
  }

  private submissionRelation(
    aiReport: { submissionId: string | null } | null,
    similarityReport: { submissionId: string | null } | null,
  ): TurnitinSubmissionRelation {
    if (!aiReport?.submissionId || !similarityReport?.submissionId) {
      return TurnitinSubmissionRelation.UNKNOWN;
    }
    return aiReport.submissionId === similarityReport.submissionId
      ? TurnitinSubmissionRelation.SAME
      : TurnitinSubmissionRelation.DIFFERENT;
  }

  private contentMatchStatus(
    aiReport: { contentMatchStatus?: TurnitinMatchStatus } | null,
    similarityReport: { contentMatchStatus?: TurnitinMatchStatus } | null,
  ): TurnitinMatchStatus {
    const statuses = [aiReport?.contentMatchStatus, similarityReport?.contentMatchStatus]
      .filter((value): value is TurnitinMatchStatus => Boolean(value))
      .filter((value) => value !== TurnitinMatchStatus.UNVERIFIED);
    if (statuses.includes(TurnitinMatchStatus.MISMATCH)) return TurnitinMatchStatus.MISMATCH;
    if (statuses.includes(TurnitinMatchStatus.PARTIAL)) return TurnitinMatchStatus.PARTIAL;
    if (statuses.includes(TurnitinMatchStatus.HIGH)) return TurnitinMatchStatus.HIGH;
    if (statuses.length && statuses.every((value) => value === TurnitinMatchStatus.EXACT)) {
      return TurnitinMatchStatus.EXACT;
    }
    return TurnitinMatchStatus.UNVERIFIED;
  }

  private async groundTruthActualData(
    aiReport: ReportRecord | null,
    similarityReport: ReportRecord | null,
    documentVersion: { id: string; wordCount: number | null; characterCount: number | null } | null,
  ) {
    const [aiSources, aiFlaggedCount, similaritySources] = await Promise.all([
      aiReport
        ? this.prisma.turnitinSource.findMany({
            where: { reportId: aiReport.id },
            orderBy: { sourceIndex: 'asc' },
            select: {
              sourceIndex: true,
              sourceType: true,
              displayName: true,
              percentageRaw: true,
              percentage: true,
              percentageIsLessThan: true,
            },
          })
        : [],
      aiReport
        ? this.prisma.turnitinSegment.count({
            where: { reportId: aiReport.id, segmentType: 'AI_FLAGGED' },
          })
        : 0,
      similarityReport
        ? this.prisma.turnitinSource.findMany({
            where: { reportId: similarityReport.id },
            orderBy: { sourceIndex: 'asc' },
            select: {
              sourceIndex: true,
              sourceType: true,
              displayName: true,
              percentageRaw: true,
              percentage: true,
              percentageIsLessThan: true,
            },
          })
        : [],
    ]);
    const toReport = (report: ReportRecord, sources: typeof aiSources) => ({
      id: report.id,
      reportType: report.reportType,
      status: report.status,
      submissionId: report.submissionId,
      wordCount: report.wordCount,
      characterCount: report.characterCount,
      aiWritingScore: report.aiWritingScore,
      similarityScore: report.similarityScore,
      internetScore: report.internetScore,
      publicationsScore: report.publicationScore,
      studentPapersScore: report.studentPapersScore,
      filters: report.filters,
      sources,
    });
    return {
      aiReport: aiReport ? { ...toReport(aiReport, aiSources), flaggedSegmentCount: aiFlaggedCount } : null,
      similarityReport: similarityReport
        ? toReport(similarityReport, similaritySources)
        : null,
      documentVersion: documentVersion
        ? {
            id: documentVersion.id,
            wordCount: documentVersion.wordCount,
            characterCount: documentVersion.characterCount,
          }
        : null,
      submissionRelation: this.submissionRelation(aiReport, similarityReport),
      contentMatchStatus: this.contentMatchStatus(aiReport, similarityReport),
    };
  }

  private logError(event: string, error: unknown): void {
    this.logger.warn(
      JSON.stringify({
        event,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
  }
}

const reportSummaryInclude = {
  _count: { select: { sources: true, segments: true } },
  documentVersion: {
    select: { id: true, document: { select: { id: true, originalName: true } } },
  },
} satisfies Prisma.TurnitinReportInclude;

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function asPlainObject(value: Prisma.JsonValue | null): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 300) : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function dateValue(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function validateExpectedData(
  expected: Record<string, unknown> | undefined,
  actual: unknown,
): TurnitinMatchStatus {
  if (!expected || Object.keys(expected).length === 0) {
    return TurnitinMatchStatus.UNVERIFIED;
  }
  return matchesSubset(expected, actual)
    ? TurnitinMatchStatus.EXACT
    : TurnitinMatchStatus.MISMATCH;
}

function matchesSubset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.every((value, index) => matchesSubset(value, actual[index]))
    );
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    return Object.entries(expectedRecord).every(([key, value]) => {
      if (key === 'submissionIdContains') {
        return (
          typeof value === 'string' &&
          typeof actualRecord.submissionId === 'string' &&
          actualRecord.submissionId.includes(value)
        );
      }
      return key in actualRecord && matchesSubset(value, actualRecord[key]);
    });
  }
  return expected === actual;
}

function isUniqueConstraint(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
