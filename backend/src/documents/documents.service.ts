import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DocumentStatus,
  ExtractionMethod,
  OcrRunStatus,
  OcrStatus,
  Prisma,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { AiExtractResponse, AiOcrProcessResponse, AiService } from '../ai/ai.service.js';
import { OcrService } from '../ocr/ocr.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BufferedUpload, validateDocumentFile } from './file-validation.js';
import { StorageService } from './storage.service.js';

const EXTRACTION_UNAVAILABLE = 'Document extraction service is unavailable';
const EXTRACTION_PERSIST_FAILED = 'Document extraction could not be saved';

type DocumentWithVersion = Prisma.DocumentGetPayload<{
  include: { currentVersion: true };
}>;

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);
  private readonly maxUploadBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly ai: AiService,
    private readonly ocr: OcrService,
    private readonly config: ConfigService,
  ) {
    this.maxUploadBytes =
      config.getOrThrow<number>('MAX_UPLOAD_MB') * 1024 * 1024;
  }

  async upload(file?: BufferedUpload) {
    const upload = validateDocumentFile(file, this.maxUploadBytes);
    let storageKey: string;
    try {
      storageKey = await this.storage.save(upload.buffer, upload.fileType);
    } catch (error) {
      this.logError('document_storage_save_failed', error);
      throw new InternalServerErrorException(
        'Document upload could not be saved',
      );
    }

    let document: DocumentWithVersion;
    try {
      document = await this.prisma.document.create({
        data: {
          originalName: upload.originalName,
          mimeType: upload.mimeType,
          size: upload.size,
          status: DocumentStatus.PROCESSING,
          currentVersion: {
            create: {
              storageKey,
              fileHash: createHash('sha256')
                .update(upload.buffer)
                .digest('hex'),
            },
          },
        },
        include: { currentVersion: true },
      });
    } catch (error) {
      await this.cleanupStoredFile(
        storageKey,
        undefined,
        'document_create_rollback_failed',
      );
      this.logError('document_create_failed', error);
      throw new InternalServerErrorException(
        'Document upload could not be saved',
      );
    }

    return this.extractAndPersist(document, {
      buffer: upload.buffer,
      mimeType: upload.mimeType,
      originalName: upload.originalName,
    });
  }

  async list(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [documents, total] = await Promise.all([
      this.prisma.document.findMany({
        skip,
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { currentVersion: true },
      }),
      this.prisma.document.count(),
    ]);
    return {
      items: documents.map((document) => this.metadata(document, false)),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getById(id: string) {
    const document = await this.findDocument(id);
    return this.metadata(document);
  }

  async getText(id: string) {
    const document = await this.findDocument(id);
    const version = document.currentVersion;
    if (!version || version.extractedText === null) {
      throw new ConflictException({
        code: 'DOCUMENT_TEXT_NOT_AVAILABLE',
        message: 'Extracted text is not available yet',
      });
    }
    return {
      documentId: document.id,
      text: version.extractedText,
      wordCount: version.wordCount,
      characterCount: version.characterCount,
    };
  }

  async getPages(id: string) {
    const document = await this.findDocument(id);
    const version = document.currentVersion;
    if (!version) return { documentId: id, documentVersionId: null, items: [] };
    const pages = await this.prisma.documentPage.findMany({
      where: { documentVersionId: version.id },
      orderBy: { pageNumber: 'asc' },
    });
    return {
      documentId: id,
      documentVersionId: version.id,
      items: pages.map((page) => ({
        pageNumber: page.pageNumber,
        width: page.width,
        height: page.height,
        rotation: page.rotation,
        extractionMethod: page.extractionMethod,
        characterCount: page.canonicalText.length,
        wordCount: page.canonicalText.trim()
          ? page.canonicalText.trim().split(/\s+/).length
          : 0,
        ocrConfidence: page.ocrConfidence,
        requiresOcr: page.requiresOcr,
        blockCount: page.ocrBlockCount,
        lowConfidenceCount: page.ocrLowConfidenceCount,
        warnings: metadataWarnings(page.ocrMetadata),
      })),
    };
  }

  async getPageDetail(versionId: string, pageNumber: number) {
    const page = await this.prisma.documentPage.findUnique({
      where: {
        documentVersionId_pageNumber: { documentVersionId: versionId, pageNumber },
      },
    });
    if (!page) {
      throw new NotFoundException({
        code: 'DOCUMENT_PAGE_NOT_FOUND',
        message: 'Document page not found',
      });
    }
    return {
      pageNumber: page.pageNumber,
      width: page.width,
      height: page.height,
      rotation: page.rotation,
      extractionMethod: page.extractionMethod,
      requiresOcr: page.requiresOcr,
      digitalText: page.digitalText,
      ocrText: page.ocrText,
      canonicalText: page.canonicalText,
      confidence: page.ocrConfidence,
      blockCount: page.ocrBlockCount,
      lowConfidenceCount: page.ocrLowConfidenceCount,
      metadata: page.ocrMetadata,
    };
  }

  async getOcrRuns(versionId: string) {
    const version = await this.prisma.documentVersion.findUnique({
      where: { id: versionId },
      select: { id: true },
    });
    if (!version) {
      throw new NotFoundException({
        code: 'DOCUMENT_NOT_FOUND',
        message: 'Document version not found',
      });
    }
    return this.prisma.ocrRun.findMany({
      where: { documentVersionId: versionId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async processOcr(
    id: string,
    options: { force?: boolean; pages?: number[] } = {},
  ) {
    const document = await this.findDocument(id);
    const version = document.currentVersion;
    if (!version) {
      throw new ServiceUnavailableException('Document file is unavailable');
    }
    const previousDocumentStatus = document.status;
    const previousOcrStatus = version.ocrStatus;
    if (!options.force && !version.requiresOcr) {
      throw new ConflictException({
        code: 'OCR_NOT_REQUIRED',
        message: 'This document does not currently require OCR',
      });
    }
    if (version.ocrStatus === OcrStatus.PROCESSING) {
      throw new ConflictException({
        code: 'OCR_ALREADY_PROCESSING',
        message: 'OCR is already processing this document',
      });
    }

    let upload: ReturnType<typeof validateDocumentFile>;
    try {
      if (!(await this.storage.exists(version.storageKey))) {
        throw new Error('Stored document is missing');
      }
      const buffer = await this.storage.read(version.storageKey);
      upload = validateDocumentFile(
        {
          buffer,
          originalname: document.originalName,
          mimetype: document.mimeType,
          size: buffer.byteLength,
        },
        this.maxUploadBytes,
      );
    } catch (error) {
      this.logError('document_ocr_storage_failed', error);
      throw new ServiceUnavailableException('Document file is unavailable');
    }

    const engine = this.config.get<string>('OCR_ENGINE') ?? 'paddleocr';
    const engineVersion = this.config.get<string>('OCR_ENGINE_VERSION') ?? '3.7.0';
    const model =
      this.config.get<string>('OCR_MODEL') ??
      'PP-OCRv5_mobile_det+latin_PP-OCRv5_mobile_rec';
    const language = this.config.get<string>('OCR_LANGUAGE') ?? 'es';
    const pipelineVersion = this.config.get<string>('OCR_PIPELINE_VERSION') ?? 'f003-v1';
    const config = {
      force: options.force ?? false,
      pages: options.pages ?? [],
      dpi: this.config.get<number>('OCR_DPI') ?? 220,
      maxRenderPixels: this.config.get<number>('OCR_MAX_RENDER_PIXELS') ?? 20_000_000,
    } satisfies Prisma.InputJsonObject;

    const run = await this.prisma.$transaction(async (tx) => {
      const createdRun = await tx.ocrRun.create({
        data: {
          documentVersionId: version.id,
          engine,
          engineVersion,
          model,
          language,
          pipelineVersion,
          status: OcrRunStatus.PROCESSING,
          config,
        },
      });
      await tx.document.update({
        where: { id },
        data: {
          status: DocumentStatus.PROCESSING,
          currentVersion: { update: { ocrStatus: OcrStatus.PROCESSING } },
        },
      });
      return createdRun;
    });

    let result: AiOcrProcessResponse;
    try {
      result = await this.ocr.processDocument(
        {
          buffer: upload.buffer,
          mimeType: upload.mimeType,
          originalName: upload.originalName,
        },
        options,
      );
      validateOcrResult(result, version.pageCount);
    } catch (error) {
      const code =
        error instanceof ServiceUnavailableException
          ? 'OCR_ENGINE_NOT_READY'
          : 'OCR_PROCESSING_FAILED';
      await this.prisma.$transaction([
        this.prisma.ocrRun.update({
          where: { id: run.id },
          data: {
            status: OcrRunStatus.FAILED,
            errorCode: code,
            errorMessage: 'OCR processing failed. Existing extracted text was preserved.',
          },
        }),
        this.prisma.document.update({
          where: { id },
          data: {
            status: previousDocumentStatus,
            currentVersion: { update: { ocrStatus: previousOcrStatus } },
          },
        }),
      ]);
      this.logError('document_ocr_failed', error);
      throw new ServiceUnavailableException({
        code,
        message: 'OCR processing failed. Existing extracted text was preserved.',
      });
    }

    const canonicalText = joinCanonicalText(result.pages);
    const requiresOcr = result.pages.some((page) => page.requiresOcr);
    const isPartial = result.pagesFailed > 0 || requiresOcr;
    const runStatus = isPartial ? OcrRunStatus.PARTIAL : OcrRunStatus.COMPLETED;
    const status = isPartial ? DocumentStatus.OCR_REQUIRED : DocumentStatus.EXTRACTED;
    const ocrStatus = isPartial ? OcrStatus.PARTIAL : OcrStatus.COMPLETED;
    const warnings = sanitizeWarnings(result.warnings);

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        for (const page of result.pages) {
          await tx.documentPage.upsert({
            where: {
              documentVersionId_pageNumber: {
                documentVersionId: version.id,
                pageNumber: page.pageNumber,
              },
            },
            create: ocrPageData(version.id, page),
            update: ocrPageData(version.id, page),
          });
        }
        if (canonicalText !== (version.extractedText ?? '')) {
          await tx.turnitinReport.updateMany({
            where: { documentVersionId: version.id },
            data: { alignmentStale: true },
          });
        }
        const updatedDocument = await tx.document.update({
          where: { id },
          data: {
            status,
            currentVersion: {
              update: {
                extractedText: canonicalText,
                pageCount: result.pages.length,
                wordCount: canonicalText.trim()
                  ? canonicalText.trim().split(/\s+/).length
                  : 0,
                characterCount: canonicalText.length,
                requiresOcr,
                ocrStatus,
                averageOcrConfidence: result.averageConfidence,
                warnings,
                extractionError: null,
              },
            },
          },
          include: { currentVersion: true },
        });
        await tx.ocrRun.update({
          where: { id: run.id },
          data: {
            engine: result.engine,
            engineVersion: result.engineVersion,
            model: result.model,
            language: result.language,
            pipelineVersion: result.pipelineVersion,
            status: runStatus,
            pagesRequested: result.pagesRequested,
            pagesProcessed: result.pagesProcessed,
            pagesSkipped: result.pagesSkipped,
            pagesFailed: result.pagesFailed,
            averageConfidence: result.averageConfidence,
            durationMs: result.durationMs,
            warningCount: warnings.length,
            errorCode: isPartial ? 'OCR_PARTIAL' : null,
            errorMessage: isPartial
              ? 'Some pages still require OCR; previously extracted text was preserved.'
              : null,
            config,
          },
        });
        return updatedDocument;
      });
      return {
        document: this.metadata(updated),
        ocr: {
          status: ocrStatus,
          extractionMethod: aggregateExtractionMethod(result.pages),
          pagesRequested: result.pagesRequested,
          pagesProcessed: result.pagesProcessed,
          pagesSkipped: result.pagesSkipped,
          pagesFailed: result.pagesFailed,
          averageConfidence: result.averageConfidence,
          warnings,
          runId: run.id,
        },
      };
    } catch (error) {
      await this.prisma
        .$transaction([
          this.prisma.ocrRun.update({
            where: { id: run.id },
            data: {
              status: OcrRunStatus.FAILED,
              errorCode: 'OCR_PERSIST_FAILED',
              errorMessage:
                'OCR output could not be saved; existing text was preserved.',
            },
          }),
          this.prisma.document.update({
            where: { id },
            data: {
              status: previousDocumentStatus,
              currentVersion: { update: { ocrStatus: previousOcrStatus } },
            },
          }),
        ])
        .catch(() => undefined);
      this.logError('document_ocr_persist_failed', error);
      throw new InternalServerErrorException('OCR output could not be saved');
    }
  }

  async processOcrForVersion(
    versionId: string,
    options: { force?: boolean; pages?: number[] } = {},
  ) {
    const version = await this.prisma.documentVersion.findUnique({
      where: { id: versionId },
      select: { documentId: true },
    });
    if (!version) {
      throw new NotFoundException({
        code: 'DOCUMENT_NOT_FOUND',
        message: 'Document version not found',
      });
    }
    return this.processOcr(version.documentId, options);
  }

  async reprocess(id: string) {
    const document = await this.findDocument(id);
    if (document.status === DocumentStatus.OCR_REQUIRED) {
      return this.processOcr(id);
    }
    if (document.status !== DocumentStatus.FAILED) {
      throw new ConflictException({
        code: 'DOCUMENT_NOT_REPROCESSABLE',
        message: 'Only failed or OCR-required documents can be reprocessed',
      });
    }

    const version = document.currentVersion;
    if (!version) {
      throw new ServiceUnavailableException('Document file is unavailable');
    }

    let upload: ReturnType<typeof validateDocumentFile>;
    try {
      if (!(await this.storage.exists(version.storageKey))) {
        throw new Error('Stored document is missing');
      }
      const buffer = await this.storage.read(version.storageKey);
      upload = validateDocumentFile(
        {
          buffer,
          originalname: document.originalName,
          mimetype: document.mimeType,
          size: buffer.byteLength,
        },
        this.maxUploadBytes,
      );
    } catch (error) {
      await this.markFailed(document.id, 'Document file is unavailable');
      this.logError('document_reprocess_storage_failed', error);
      throw new ServiceUnavailableException('Document file is unavailable');
    }

    const processing = await this.prisma.document.update({
      where: { id },
      data: {
        status: DocumentStatus.PROCESSING,
        currentVersion: { update: { extractionError: null } },
      },
      include: { currentVersion: true },
    });
    return this.extractAndPersist(processing, {
      buffer: upload.buffer,
      mimeType: upload.mimeType,
      originalName: upload.originalName,
    });
  }

  async remove(id: string) {
    const document = await this.findDocument(id);
    const storageKey = document.currentVersion?.storageKey;
    await this.prisma.document.delete({ where: { id } });
    if (storageKey)
      await this.cleanupStoredFile(
        storageKey,
        id,
        'document_storage_cleanup_failed',
      );
    return { status: 'deleted', id };
  }

  private async extractAndPersist(
    document: DocumentWithVersion,
    file: { buffer: Buffer; mimeType: string; originalName: string },
  ) {
    if (!document.currentVersion) {
      await this.markFailed(
        document.id,
        'Document version could not be loaded',
        false,
      );
      throw new InternalServerErrorException(
        'Document version could not be loaded',
      );
    }

    let extraction: AiExtractResponse;
    try {
      extraction = await this.ai.extractDocument(file);
    } catch (error) {
      await this.markFailed(document.id, EXTRACTION_UNAVAILABLE);
      this.logError('document_extraction_failed', error);
      throw new ServiceUnavailableException(EXTRACTION_UNAVAILABLE);
    }

    const warnings = sanitizeWarnings(extraction.warnings);
    let updated: DocumentWithVersion;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        const updatedDocument = await tx.document.update({
          where: { id: document.id },
          data: {
            status: extraction.requiresOcr
              ? DocumentStatus.OCR_REQUIRED
              : DocumentStatus.EXTRACTED,
            currentVersion: {
              update: {
                extractedText: extraction.text,
                pageCount: extraction.pageCount,
                wordCount: extraction.wordCount,
                characterCount: extraction.characterCount,
                requiresOcr: extraction.requiresOcr,
                ocrStatus: extraction.requiresOcr
                  ? OcrStatus.REQUIRED
                  : OcrStatus.NOT_NEEDED,
                averageOcrConfidence: null,
                warnings,
                extractionError: null,
              },
            },
          },
          include: { currentVersion: true },
        });
        for (const page of extraction.pages) {
          await tx.documentPage.upsert({
            where: {
              documentVersionId_pageNumber: {
                documentVersionId: document.currentVersion!.id,
                pageNumber: page.pageNumber,
              },
            },
            create: {
              documentVersionId: document.currentVersion!.id,
              pageNumber: page.pageNumber,
              width: page.width,
              height: page.height,
              rotation: page.rotation,
              extractionMethod: page.extractionMethod as ExtractionMethod,
              digitalText: page.digitalText || null,
              canonicalText: page.canonicalText,
              requiresOcr: page.requiresOcr,
              ocrMetadata: {
                classification: page.classification,
                imageAreaRatio: page.imageAreaRatio,
                warnings: page.warnings,
              },
            },
            update: {
              width: page.width,
              height: page.height,
              rotation: page.rotation,
              extractionMethod: page.extractionMethod as ExtractionMethod,
              digitalText: page.digitalText || null,
              canonicalText: page.canonicalText,
              requiresOcr: page.requiresOcr,
              ocrMetadata: {
                classification: page.classification,
                imageAreaRatio: page.imageAreaRatio,
                warnings: page.warnings,
              },
            },
          });
        }
        return updatedDocument;
      });
    } catch (error) {
      await this.markFailed(document.id, EXTRACTION_PERSIST_FAILED);
      this.logError('document_extraction_persist_failed', error);
      throw new InternalServerErrorException(EXTRACTION_PERSIST_FAILED);
    }

    return this.metadata(updated);
  }

  private async findDocument(id: string): Promise<DocumentWithVersion> {
    const document = await this.prisma.document.findUnique({
      where: { id },
      include: { currentVersion: true },
    });
    if (!document) {
      throw new NotFoundException({
        code: 'DOCUMENT_NOT_FOUND',
        message: 'Document not found',
      });
    }
    return document;
  }

  private metadata(document: DocumentWithVersion, includePreview = true) {
    const version = document.currentVersion;
    return {
      id: document.id,
      documentVersionId: version?.id ?? null,
      originalName: document.originalName,
      mimeType: document.mimeType,
      extension: document.originalName.split('.').pop()?.toLowerCase() ?? '',
      sizeBytes: document.size,
      status: document.status,
      sha256: version?.fileHash ?? null,
      pageCount: version?.pageCount ?? null,
      wordCount: version?.wordCount ?? null,
      characterCount: version?.characterCount ?? null,
      requiresOcr: version?.requiresOcr ?? false,
      ocrStatus: version?.ocrStatus ?? OcrStatus.NOT_NEEDED,
      averageOcrConfidence: version?.averageOcrConfidence ?? null,
      extractionError: version?.extractionError ?? null,
      warnings: version?.warnings ?? [],
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      ...(includePreview
        ? {
            textPreview: Array.from(version?.extractedText ?? '')
              .slice(0, 2000)
              .join(''),
          }
        : {}),
    };
  }

  private async markFailed(
    id: string,
    extractionError: string,
    hasVersion = true,
  ): Promise<void> {
    try {
      await this.prisma.document.update({
        where: { id },
        data: {
          status: DocumentStatus.FAILED,
          ...(hasVersion
            ? { currentVersion: { update: { extractionError } } }
            : {}),
        },
      });
    } catch (error) {
      this.logError('document_failed_status_update_failed', error);
    }
  }

  private async cleanupStoredFile(
    storageKey: string,
    documentId: string | undefined,
    event: string,
  ): Promise<void> {
    try {
      const deleted = await this.storage.delete(storageKey);
      if (!deleted) {
        this.logger.warn(
          JSON.stringify({ event, documentId, errorType: 'StoredFileMissing' }),
        );
      }
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event,
          documentId,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
    }
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

function sanitizeWarnings(warnings: string[]): string[] {
  return warnings.slice(0, 20).map((warning) => {
    const cleaned = Array.from(warning)
      .filter((character) => {
        const code = character.codePointAt(0);
        return code === undefined || (code >= 32 && code !== 127);
      })
      .join('')
      .replace(/\b[A-Za-z]:[\\/][^\s"'<>]*/g, '[path]')
      .replace(/(^|[\s("'=])\/(?:[^\s"'<>]+\/?)+/g, '$1[path]')
      .trim();
    return cleaned.slice(0, 300);
  });
}

function metadataWarnings(value: Prisma.JsonValue | null): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const warnings = value.warnings;
  return Array.isArray(warnings)
    ? warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
}

function joinCanonicalText(pages: AiOcrProcessResponse['pages']): string {
  return pages
    .slice()
    .sort((left, right) => left.pageNumber - right.pageNumber)
    .map((page) => page.canonicalText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\x00/g, ''))
    .join('\n');
}

function validateOcrResult(
  result: AiOcrProcessResponse,
  expectedPageCount: number | null,
): void {
  if (
    expectedPageCount !== null &&
    result.pages.length !== expectedPageCount
  ) {
    throw new Error('OCR response page count does not match the stored document');
  }
  const pageNumbers = new Set<number>();
  for (const page of result.pages) {
    if (
      !Number.isInteger(page.pageNumber) ||
      page.pageNumber < 1 ||
      pageNumbers.has(page.pageNumber) ||
      !Number.isFinite(page.width) ||
      !Number.isFinite(page.height) ||
      !['DIGITAL', 'OCR', 'HYBRID', 'NONE'].includes(page.extractionMethod) ||
      (page.confidence !== null &&
        (!Number.isFinite(page.confidence) ||
          page.confidence < 0 ||
          page.confidence > 1)) ||
      !Array.isArray(page.blocks)
    ) {
      throw new Error('OCR response contains invalid page metadata');
    }
    pageNumbers.add(page.pageNumber);
    for (const block of page.blocks) {
      const bounds = block.bbox;
      if (
        !block.text ||
        !Number.isInteger(block.readingOrder) ||
        !bounds ||
        ![bounds.x0, bounds.y0, bounds.x1, bounds.y1].every(Number.isFinite) ||
        bounds.x1 < bounds.x0 ||
        bounds.y1 < bounds.y0 ||
        (block.confidence !== null &&
          (!Number.isFinite(block.confidence) ||
            block.confidence < 0 ||
            block.confidence > 1))
      ) {
        throw new Error('OCR response contains an invalid text block');
      }
    }
  }
}

function ocrPageData(
  documentVersionId: string,
  page: AiOcrProcessResponse['pages'][number],
): Prisma.DocumentPageUncheckedCreateInput {
  const blocks = page.blocks.map((block) => ({
    order: block.readingOrder,
    text: block.text,
    confidence: block.confidence,
    bbox: block.bbox,
    lowConfidence: block.lowConfidence,
    duplicateOfDigital: block.duplicateOfDigital,
  }));
  const metadata = {
    classification: page.classification,
    imageAreaRatio: page.imageAreaRatio,
    deskewAngle: page.deskewAngle,
    warnings: page.warnings,
    errorCode: page.ocrErrorCode,
    blocks,
  } satisfies Prisma.InputJsonObject;
  return {
    documentVersionId,
    pageNumber: page.pageNumber,
    width: page.width,
    height: page.height,
    rotation: page.rotation,
    extractionMethod: page.extractionMethod as ExtractionMethod,
    digitalText: page.digitalText || null,
    ocrText: page.ocrText,
    canonicalText: page.canonicalText,
    requiresOcr: page.requiresOcr,
    ocrConfidence: page.confidence,
    ocrBlockCount: page.blocks.length,
    ocrLowConfidenceCount: page.blocks.filter((block) => block.lowConfidence).length,
    ocrMetadata: metadata,
  };
}

function aggregateExtractionMethod(
  pages: AiOcrProcessResponse['pages'],
): ExtractionMethod {
  const methods = new Set(pages.map((page) => page.extractionMethod));
  if (methods.has('HYBRID') || (methods.has('DIGITAL') && methods.has('OCR'))) {
    return ExtractionMethod.HYBRID;
  }
  if (methods.has('OCR')) return ExtractionMethod.OCR;
  if (methods.has('DIGITAL')) return ExtractionMethod.DIGITAL;
  return ExtractionMethod.NONE;
}
