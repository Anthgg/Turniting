import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentStatus, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AiExtractResponse, AiService } from '../ai/ai.service.js';
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
    config: ConfigService,
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

  async reprocess(id: string) {
    const document = await this.findDocument(id);
    if (
      document.status !== DocumentStatus.FAILED &&
      document.status !== DocumentStatus.OCR_REQUIRED
    ) {
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
      updated = await this.prisma.document.update({
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
              warnings,
              extractionError: null,
            },
          },
        },
        include: { currentVersion: true },
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
    if (!document) throw new NotFoundException('Document not found');
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
