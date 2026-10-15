import { ConfigModule } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentStatus } from '@prisma/client';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  AiExtractResponse,
  AiService,
  AiDocumentFile,
} from '../src/ai/ai.service.js';
import { configureApplication } from '../src/common/configure-application.js';
import { validateEnvironment } from '../src/config/env.validation.js';
import { DocumentsModule } from '../src/documents/documents.module.js';
import { LocalStorageService } from '../src/documents/local-storage.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { makeDocx } from './document-fixtures.js';

type StoredVersion = {
  id: string;
  documentId: string;
  storageKey: string;
  fileHash: string;
  extractedText: string | null;
  extractionError: string | null;
  pageCount: number | null;
  wordCount: number | null;
  characterCount: number | null;
  requiresOcr: boolean;
  warnings: string[];
  createdAt: Date;
  updatedAt: Date;
};

type StoredDocument = {
  id: string;
  userId: string | null;
  originalName: string;
  mimeType: string;
  size: number;
  status: DocumentStatus;
  createdAt: Date;
  updatedAt: Date;
  currentVersion: StoredVersion | null;
};

type UpdateData = {
  status?: DocumentStatus;
  currentVersion?: { update: Partial<StoredVersion> };
};

function createInMemoryPrisma() {
  const rows = new Map<string, StoredDocument>();
  let sequence = 0;
  const document = {
    create: vi.fn(
      async (args: {
        data: {
          originalName: string;
          mimeType: string;
          size: number;
          status: DocumentStatus;
          currentVersion: { create: { storageKey: string; fileHash: string } };
        };
      }) => {
        sequence += 1;
        const id = randomUUID();
        const now = new Date(Date.now() + sequence * 1000);
        const row: StoredDocument = {
          id,
          userId: null,
          originalName: args.data.originalName,
          mimeType: args.data.mimeType,
          size: args.data.size,
          status: args.data.status,
          createdAt: now,
          updatedAt: now,
          currentVersion: {
            id: randomUUID(),
            documentId: id,
            storageKey: args.data.currentVersion.create.storageKey,
            fileHash: args.data.currentVersion.create.fileHash,
            extractedText: null,
            extractionError: null,
            pageCount: null,
            wordCount: null,
            characterCount: null,
            requiresOcr: false,
            warnings: [],
            createdAt: now,
            updatedAt: now,
          },
        };
        rows.set(id, row);
        return row;
      },
    ),
    update: vi.fn(async (args: { where: { id: string }; data: UpdateData }) => {
      const row = rows.get(args.where.id);
      if (!row) throw new Error('record not found');
      if (args.data.status) row.status = args.data.status;
      if (args.data.currentVersion && row.currentVersion) {
        Object.assign(row.currentVersion, args.data.currentVersion.update);
        row.currentVersion.updatedAt = new Date();
      }
      row.updatedAt = new Date();
      return row;
    }),
    findUnique: vi.fn(
      async (args: { where: { id: string } }) =>
        rows.get(args.where.id) ?? null,
    ),
    findMany: vi.fn(async (args: { skip: number; take: number }) =>
      Array.from(rows.values())
        .sort(
          (left, right) =>
            right.createdAt.getTime() - left.createdAt.getTime() ||
            right.id.localeCompare(left.id),
        )
        .slice(args.skip, args.skip + args.take),
    ),
    count: vi.fn(async () => rows.size),
    delete: vi.fn(async (args: { where: { id: string } }) => {
      const row = rows.get(args.where.id);
      if (!row) throw new Error('record not found');
      rows.delete(args.where.id);
      return row;
    }),
  };
  return {
    document,
    rows,
    reset() {
      rows.clear();
      sequence = 0;
      vi.clearAllMocks();
    },
  };
}

function extractionFor(
  file: AiDocumentFile,
  overrides: Partial<AiExtractResponse> = {},
): AiExtractResponse {
  const fileType = file.originalName
    .split('.')
    .pop()
    ?.toLowerCase() as AiExtractResponse['fileType'];
  const text = 'Extracted document text';
  return {
    status: 'success',
    fileType,
    text,
    pageCount: fileType === 'txt' ? null : 1,
    wordCount: 3,
    characterCount: text.length,
    requiresOcr: false,
    warnings: [],
    ...overrides,
  };
}

describe('document ingestion endpoints', () => {
  let app: INestApplication<App>;
  let tempRoot: string;
  let uploadDir: string;
  let db: ReturnType<typeof createInMemoryPrisma>;
  let ai: {
    extractDocument: ReturnType<
      typeof vi.fn<(file: AiDocumentFile) => Promise<AiExtractResponse>>
    >;
  };
  let storage: LocalStorageService;

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'turniting-documents-test-'));
    uploadDir = path.join(tempRoot, 'uploads');
    db = createInMemoryPrisma();
    ai = {
      extractDocument: vi.fn(async (file: AiDocumentFile) =>
        extractionFor(file),
      ),
    };

    const moduleFixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validate: (config) =>
            validateEnvironment({
              ...config,
              NODE_ENV: 'test',
              DATABASE_URL:
                'postgresql://test:test@127.0.0.1:5432/turniting_test',
              DIRECT_URL:
                'postgresql://test:test@127.0.0.1:5432/turniting_test',
              AI_SERVICE_URL: 'http://ai-service:8000',
              CORS_ORIGIN: 'http://localhost:5173',
              UPLOAD_DIR: uploadDir,
              MAX_UPLOAD_MB: '1',
              AI_SERVICE_TIMEOUT_MS: '1000',
              AI_SERVICE_AUTH_MODE: 'none',
            }),
        }),
        DocumentsModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(db)
      .overrideProvider(AiService)
      .useValue(ai)
      .compile();

    storage = moduleFixture.get(LocalStorageService);
    app = moduleFixture.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  beforeEach(async () => {
    db.reset();
    ai.extractDocument
      .mockReset()
      .mockImplementation(async (file) => extractionFor(file));
    await rm(uploadDir, { recursive: true, force: true });
    await mkdir(uploadDir, { recursive: true });
  });

  afterAll(async () => {
    await app?.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it.each([
    {
      filename: 'report.pdf',
      contentType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7\nsource'),
    },
    {
      filename: 'report.docx',
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: makeDocx(),
    },
    {
      filename: 'report.txt',
      contentType: 'text/plain',
      buffer: Buffer.from('source text with áccents', 'utf8'),
    },
  ])(
    'uploads and hashes $filename while keeping file bytes and extracted text outside Document',
    async (file) => {
      const response = await request(app.getHttpServer())
        .post('/api/documents')
        .attach('file', file.buffer, {
          filename: file.filename,
          contentType: file.contentType,
        })
        .expect(201);

      expect(response.body.status).toBe(DocumentStatus.EXTRACTED);
      expect(response.body.sha256).toBe(
        createHash('sha256').update(file.buffer).digest('hex'),
      );
      expect(response.body.extension).toBe(file.filename.split('.').pop());
      expect(response.body.sizeBytes).toBe(file.buffer.length);
      expect(response.body.extractionError).toBeNull();
      expect(response.body.originalName).toBe(file.filename);
      expect(response.body.textPreview).toBe('Extracted document text');
      expect(response.body.warnings).toEqual([]);
      expect(JSON.stringify(response.body)).not.toContain(uploadDir);
      expect(response.body).not.toHaveProperty('storageKey');
      expect(ai.extractDocument).toHaveBeenCalledTimes(1);
      expect(ai.extractDocument.mock.calls[0]?.[0].buffer).toEqual(file.buffer);

      const row = [...db.rows.values()][0];
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty('extractedText');
      expect(row?.currentVersion?.extractedText).toBe(
        'Extracted document text',
      );
      expect(await storage.read(row?.currentVersion?.storageKey ?? '')).toEqual(
        file.buffer,
      );
    },
  );

  it('sanitizes names supplied with a client path before persistence and AI forwarding', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/documents')
      .attach('file', Buffer.from('safe text'), {
        filename: '..\\private\\report.txt',
        contentType: 'text/plain',
      })
      .expect(201);

    expect(response.body.originalName).toBe('report.txt');
    expect(ai.extractDocument.mock.calls[0]?.[0].originalName).toBe(
      'report.txt',
    );
    expect(JSON.stringify(response.body)).not.toContain('private');
  });

  it('accepts Windows-1252 text and forwards its original bytes to FastAPI', async () => {
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    await request(app.getHttpServer())
      .post('/api/documents')
      .attach('file', bytes, {
        filename: 'legacy.txt',
        contentType: 'text/plain',
      })
      .expect(201);
    expect(ai.extractDocument.mock.calls[0]?.[0].buffer).toEqual(bytes);
  });

  it('rejects unsupported, mismatched, and signature-invalid uploads before writing files or rows', async () => {
    const unsupported = await request(app.getHttpServer())
      .post('/api/documents')
      .attach('file', Buffer.from('binary'), {
        filename: 'virus.exe',
        contentType: 'application/octet-stream',
      })
      .expect(415);
    expect(unsupported.body.code).toBe('UNSUPPORTED_FILE_TYPE');

    const mimeMismatch = await request(app.getHttpServer())
      .post('/api/documents')
      .attach('file', Buffer.from('%PDF-1.7'), {
        filename: 'report.pdf',
        contentType: 'text/plain',
      })
      .expect(415);
    expect(mimeMismatch.body.code).toBe('FILE_MIME_MISMATCH');

    const invalidSignature = await request(app.getHttpServer())
      .post('/api/documents')
      .attach('file', Buffer.from('not a pdf'), {
        filename: 'report.pdf',
        contentType: 'application/pdf',
      })
      .expect(415);
    expect(invalidSignature.body.code).toBe('INVALID_FILE_SIGNATURE');
    expect(db.rows.size).toBe(0);
    expect(ai.extractDocument).not.toHaveBeenCalled();
    expect(await readdir(uploadDir)).toEqual([]);
  });

  it('returns stable FILE_TOO_LARGE/413 before storage', async () => {
    const tooLarge = Buffer.concat([
      Buffer.from('%PDF-1.7'),
      Buffer.alloc(1024 * 1024),
    ]);
    const response = await request(app.getHttpServer())
      .post('/api/documents')
      .attach('file', tooLarge, {
        filename: 'large.pdf',
        contentType: 'application/pdf',
      })
      .expect(413);
    expect(response.body.code).toBe('FILE_TOO_LARGE');
    expect(response.body.statusCode).toBe(413);
    expect(db.rows.size).toBe(0);
    expect(await readdir(uploadDir)).toEqual([]);
  });

  it('returns paginated newest-first metadata and detail previews capped at 2000 characters', async () => {
    const createUpload = (filename: string) =>
      request(app.getHttpServer())
        .post('/api/documents')
        .attach('file', Buffer.from('plain text'), {
          filename,
          contentType: 'text/plain',
        })
        .expect(201);

    const first = await createUpload('first.txt');
    const second = await createUpload('second.txt');
    ai.extractDocument.mockResolvedValueOnce(
      extractionFor(
        {
          buffer: Buffer.from('x'),
          mimeType: 'text/plain',
          originalName: 'long.txt',
        },
        { text: 'x'.repeat(2001) },
      ),
    );
    const long = await createUpload('long.txt');

    const listing = await request(app.getHttpServer())
      .get('/api/documents?page=1&limit=2')
      .expect(200);
    expect(listing.body).toMatchObject({
      page: 1,
      limit: 2,
      total: 3,
      totalPages: 2,
    });
    expect(
      listing.body.items.map((document: { id: string }) => document.id),
    ).toEqual([long.body.id, second.body.id]);
    expect(listing.body.items[0]).not.toHaveProperty('textPreview');
    expect(listing.body.items[0]).not.toHaveProperty('extractedText');

    const detail = await request(app.getHttpServer())
      .get(`/api/documents/${long.body.id}`)
      .expect(200);
    expect(detail.body.textPreview).toHaveLength(2000);
    const text = await request(app.getHttpServer())
      .get(`/api/documents/${long.body.id}/text`)
      .expect(200);
    expect(text.body.text).toBe('x'.repeat(2001));
    expect(text.body.documentId).toBe(long.body.id);
    expect(first.body.id).not.toBe(second.body.id);
  });

  it('validates pagination bounds and UUID route parameters', async () => {
    await request(app.getHttpServer()).get('/api/documents?page=0').expect(400);
    await request(app.getHttpServer())
      .get('/api/documents?limit=101')
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/documents/not-a-uuid')
      .expect(400);
  });

  it('stores extraction failures as FAILED, keeps the file for audit, and reprocesses only eligible rows', async () => {
    ai.extractDocument.mockRejectedValueOnce(
      new Error('private text and path detail'),
    );
    const failed = await request(app.getHttpServer())
      .post('/api/documents')
      .attach('file', Buffer.from('plain text'), {
        filename: 'failed.txt',
        contentType: 'text/plain',
      })
      .expect(503);
    expect(failed.body.message).toBe('Service temporarily unavailable');
    expect(JSON.stringify(failed.body)).not.toContain('private text');
    const row = [...db.rows.values()][0];
    expect(row?.status).toBe(DocumentStatus.FAILED);
    expect(row?.currentVersion?.extractionError).toBe(
      'Document extraction service is unavailable',
    );
    const storageKey = row?.currentVersion?.storageKey ?? '';
    expect(await storage.exists(storageKey)).toBe(true);

    ai.extractDocument.mockResolvedValueOnce(
      extractionFor({
        buffer: Buffer.from('plain text'),
        mimeType: 'text/plain',
        originalName: 'failed.txt',
      }),
    );
    await request(app.getHttpServer())
      .post(`/api/documents/${row?.id}/reprocess`)
      .expect(201);
    expect(db.rows.get(row?.id ?? '')?.status).toBe(DocumentStatus.EXTRACTED);
    expect(
      db.rows.get(row?.id ?? '')?.currentVersion?.extractionError,
    ).toBeNull();
    await request(app.getHttpServer())
      .post(`/api/documents/${row?.id}/reprocess`)
      .expect(409);
  });

  it('marks the document FAILED when extracted text cannot be persisted', async () => {
    db.document.update.mockRejectedValueOnce(
      new Error('database connection details'),
    );
    const response = await request(app.getHttpServer())
      .post('/api/documents')
      .attach('file', Buffer.from('plain text'), {
        filename: 'persistence.txt',
        contentType: 'text/plain',
      })
      .expect(500);

    expect(response.body.message).toBe('Internal server error');
    const row = [...db.rows.values()][0];
    expect(row?.status).toBe(DocumentStatus.FAILED);
    expect(row?.currentVersion?.extractionError).toBe(
      'Document extraction could not be saved',
    );
    expect(await storage.exists(row?.currentVersion?.storageKey ?? '')).toBe(
      true,
    );
  });

  it('marks OCR-required results and allows their reprocessing', async () => {
    ai.extractDocument.mockResolvedValueOnce(
      extractionFor(
        {
          buffer: Buffer.from('plain text'),
          mimeType: 'text/plain',
          originalName: 'scan.txt',
        },
        { requiresOcr: true, warnings: ['OCR is required'] },
      ),
    );
    const uploaded = await request(app.getHttpServer())
      .post('/api/documents')
      .attach('file', Buffer.from('plain text'), {
        filename: 'scan.txt',
        contentType: 'text/plain',
      })
      .expect(201);
    expect(uploaded.body.status).toBe(DocumentStatus.OCR_REQUIRED);
    await request(app.getHttpServer())
      .post(`/api/documents/${uploaded.body.id}/reprocess`)
      .expect(201);
  });

  it('deletes the database record and cascaded version before cleaning the physical file', async () => {
    const uploaded = await request(app.getHttpServer())
      .post('/api/documents')
      .attach('file', Buffer.from('plain text'), {
        filename: 'delete.txt',
        contentType: 'text/plain',
      })
      .expect(201);
    const row = db.rows.get(uploaded.body.id);
    const storageKey = row?.currentVersion?.storageKey ?? '';
    expect(await storage.exists(storageKey)).toBe(true);

    await request(app.getHttpServer())
      .delete(`/api/documents/${uploaded.body.id}`)
      .expect(200, {
        status: 'deleted',
        id: uploaded.body.id,
      });
    expect(db.rows.has(uploaded.body.id)).toBe(false);
    expect(await storage.exists(storageKey)).toBe(false);
    expect(await readdir(uploadDir)).toEqual([]);
  });

  it('removes a stored file when the database create fails and never returns the underlying error', async () => {
    db.document.create.mockRejectedValueOnce(
      new Error('database password and full connection URL'),
    );
    const response = await request(app.getHttpServer())
      .post('/api/documents')
      .attach('file', Buffer.from('private document body'), {
        filename: 'private.txt',
        contentType: 'text/plain',
      })
      .expect(500);
    expect(response.body.message).toBe('Internal server error');
    expect(JSON.stringify(response.body)).not.toContain('database password');
    expect(JSON.stringify(response.body)).not.toContain(
      'private document body',
    );
    expect(db.rows.size).toBe(0);
    expect(ai.extractDocument).not.toHaveBeenCalled();
    expect(await readdir(uploadDir)).toEqual([]);
  });

  it('does not disclose storage paths or file contents in 503 extraction errors', async () => {
    ai.extractDocument.mockRejectedValueOnce(
      new Error(`${uploadDir} private document content`),
    );
    const response = await request(app.getHttpServer())
      .post('/api/documents')
      .attach('file', Buffer.from('private document content'), {
        filename: 'private.txt',
        contentType: 'text/plain',
      })
      .expect(503);
    expect(JSON.stringify(response.body)).not.toContain(uploadDir);
    expect(JSON.stringify(response.body)).not.toContain(
      'private document content',
    );
    expect(JSON.stringify(response.body)).not.toContain('storageKey');
  });
});
