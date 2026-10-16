import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { GroundTruthCaseType, TurnitinReportType } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiService, type AiTurnitinParseResponse } from '../ai/ai.service.js';
import type { StorageService } from '../documents/storage.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { OcrService } from '../ocr/ocr.service.js';
import { GroundTruthCaseTypeDto } from './dto/turnitin.dto.js';
import { TurnitinService } from './turnitin.service.js';

const reportId = 'b12a8b36-4bf4-4cbe-86ef-873ff7fbc0da';
const submissionDifferentId = 'a6ee5ef8-2d25-41e7-89f8-5c9c57f9422a';
const validPdf = Buffer.from('%PDF-1.7 synthetic Turnitin report');

function parsedAiReport(): AiTurnitinParseResponse {
  return {
    status: 'PARSED',
    reportType: 'AI_WRITING',
    parserVersion: 'f002-v1',
    metadata: { submissionId: 'trn:oid:::12345:67890', wordCount: 1461 },
    scores: {
      aiWriting: { raw: '67%', percentage: 67, percentageIsLessThan: false },
    },
    filters: [],
    sources: [],
    segments: [],
    warnings: [],
    documentText: 'Synthetic report text with enough words for alignment.',
  };
}

function reportRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: reportId,
    originalName: 'synthetic-ai-report.pdf',
    mimeType: 'application/pdf',
    size: validPdf.length,
    fileHash: 'a'.repeat(64),
    storageKey: 'turnitin/synthetic.pdf',
    reportType: TurnitinReportType.AI_WRITING,
    status: 'PARSED',
    parserVersion: 'f002-v1',
    submissionId: 'trn:oid:::12345:67890',
    submissionFileName: null,
    reportPageCount: 3,
    documentPageCount: 2,
    wordCount: 1461,
    characterCount: 9191,
    aiWritingScore: 67,
    aiWritingScoreRaw: '67%',
    similarityScore: null,
    similarityScoreRaw: null,
    internetScore: null,
    internetScoreRaw: null,
    publicationScore: null,
    publicationScoreRaw: null,
    studentPapersScore: null,
    studentPapersScoreRaw: null,
    filters: [],
    warnings: [],
    reportMetadata: { submissionId: 'trn:oid:::12345:67890' },
    documentVersionId: null,
    contentMatchStatus: 'UNVERIFIED',
    submissionRelation: 'UNKNOWN',
    contentSimilarityRatio: null,
    contentMatchEvidence: null,
    matchedAt: null,
    createdAt: new Date('2026-10-15T00:00:00Z'),
    updatedAt: new Date('2026-10-15T00:00:00Z'),
    _count: { sources: 0, segments: 0 },
    documentVersion: null,
    ...overrides,
  };
}

describe('TurnitinService', () => {
  let service: TurnitinService;
  let prisma: Record<string, any>;
  let transaction: Record<string, any>;
  let storage: Record<string, any>;
  let ai: Record<string, any>;

  beforeEach(() => {
    transaction = {
      turnitinReport: {
        create: vi.fn().mockResolvedValue({ id: reportId }),
        update: vi.fn().mockResolvedValue({ id: reportId }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(reportRecord()),
      },
      turnitinSource: { create: vi.fn(), deleteMany: vi.fn() },
      turnitinSegment: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
        updateMany: vi.fn(),
      },
      groundTruthCase: { create: vi.fn() },
    };
    prisma = {
      $transaction: vi.fn(async (callback: (tx: Record<string, any>) => unknown) => callback(transaction)),
      turnitinReport: {
        findUnique: vi.fn().mockResolvedValue(reportRecord()),
        delete: vi.fn(),
      },
      turnitinSource: { findMany: vi.fn().mockResolvedValue([]) },
      turnitinSegment: { count: vi.fn().mockResolvedValue(2) },
      documentVersion: { findUnique: vi.fn().mockResolvedValue(null) },
      groundTruthCase: {
        create: vi.fn(async ({ data }) => data),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        update: vi.fn(),
      },
    };
    storage = {
      saveTurnitinReport: vi.fn().mockResolvedValue('turnitin/synthetic.pdf'),
      exists: vi.fn().mockResolvedValue(true),
      read: vi.fn().mockResolvedValue(validPdf),
      delete: vi.fn().mockResolvedValue(true),
    };
    ai = {
      parseTurnitinReport: vi.fn().mockResolvedValue(parsedAiReport()),
      alignTurnitinReport: vi.fn(),
    };
    const ocr = {
      processDocument: vi.fn(),
      parseTurnitinOcrText: vi.fn(),
    };
    service = new TurnitinService(
      prisma as unknown as PrismaService,
      storage as unknown as StorageService,
      ai as unknown as AiService,
      ocr as unknown as OcrService,
      { getOrThrow: () => 30 } as unknown as ConfigService,
    );
  });

  it('stores PDF reports privately and persists parser output with a content hash', async () => {
    prisma.turnitinReport.findUnique.mockResolvedValue(reportRecord());
    const result = await service.upload({
      buffer: validPdf,
      originalname: 'synthetic-ai-report.pdf',
      mimetype: 'application/pdf',
      size: validPdf.length,
    });

    expect(storage.saveTurnitinReport).toHaveBeenCalledWith(validPdf);
    expect(transaction.turnitinReport.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storageKey: 'turnitin/synthetic.pdf',
        reportType: TurnitinReportType.AI_WRITING,
        aiWritingScore: 67,
        aiWritingScoreRaw: '67%',
        fileHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
    expect(result.reportType).toBe('AI_WRITING');
    expect(result.scores.aiWriting).toEqual({ raw: '67%', percentage: 67 });
  });

  it('keeps the uploaded report and records a retryable status when FastAPI is unavailable', async () => {
    ai.parseTurnitinReport.mockRejectedValueOnce(new Error('private parser failure'));
    prisma.turnitinReport.findUnique.mockResolvedValue(
      reportRecord({ status: 'FAILED', reportType: 'UNKNOWN', warnings: [
        'The report parser was unavailable. The file is saved and can be reparsed.',
      ] }),
    );

    const result = await service.upload({
      buffer: validPdf,
      originalname: 'synthetic-ai-report.pdf',
      mimetype: 'application/pdf',
      size: validPdf.length,
    });

    expect(result.status).toBe('FAILED');
    expect(storage.saveTurnitinReport).toHaveBeenCalledOnce();
    expect(transaction.turnitinReport.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ reportType: 'UNKNOWN', status: 'FAILED' }),
    });
  });

  it('does not discard existing parsed rows when a reparse fails', async () => {
    ai.parseTurnitinReport.mockRejectedValueOnce(new Error('synthetic parse failure'));

    await expect(service.reparse(reportId)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(transaction.turnitinSegment.deleteMany).not.toHaveBeenCalled();
    expect(transaction.turnitinSource.deleteMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects incomplete AI ground truth references before writing records', async () => {
    await expect(
      service.createGroundTruthCase({
        name: 'SYNTHETIC_AI_CASE',
        caseType: GroundTruthCaseTypeDto.AI_REPORT,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.groundTruthCase.create).not.toHaveBeenCalled();
  });

  it('allows a validation case with any subset of optional report/document references', async () => {
    const result = await service.createGroundTruthCase({
      name: 'SYNTHETIC_OPTIONAL_REFERENCE_CASE',
      caseType: GroundTruthCaseTypeDto.VALIDATION,
      aiReportId: reportId,
    });

    expect(result.aiReportId).toBe(reportId);
    expect(result.similarityReportId).toBeUndefined();
    expect(result.documentVersionId).toBeUndefined();
    expect(result.submissionRelation).toBe('UNKNOWN');
    expect(result.validationStatus).toBe('UNVERIFIED');
  });

  it('records distinct submission identities and validates expected report values', async () => {
    const aiReport = reportRecord();
    const similarityReport = reportRecord({
      id: submissionDifferentId,
      reportType: TurnitinReportType.SIMILARITY,
      submissionId: 'trn:oid:::12345:67891',
      aiWritingScore: null,
      aiWritingScoreRaw: null,
      similarityScore: 3,
      similarityScoreRaw: '3%',
    });
    prisma.turnitinReport.findUnique.mockImplementation(async ({ where }) =>
      where.id === reportId ? aiReport : similarityReport,
    );
    prisma.documentVersion.findUnique.mockResolvedValue({
      id: '24bcb810-8476-4e30-8d10-cd452ba8196b',
      wordCount: 1461,
      characterCount: 9191,
    });
    prisma.turnitinSegment.count.mockResolvedValue(4);

    const result = await service.createGroundTruthCase({
      name: 'SYNTHETIC_VALIDATION_CASE',
      caseType: GroundTruthCaseType.VALIDATION,
      aiReportId: reportId,
      similarityReportId: submissionDifferentId,
      documentVersionId: '24bcb810-8476-4e30-8d10-cd452ba8196b',
      expectedData: {
        aiReport: { aiWritingScore: 67, flaggedSegmentCount: 4 },
        similarityReport: { similarityScore: 3 },
        submissionRelation: 'DIFFERENT',
      },
    });

    expect(result.submissionRelation).toBe('DIFFERENT');
    expect(result.validationStatus).toBe('EXACT');
    expect(result.actualData.aiReport.flaggedSegmentCount).toBe(4);
    expect(prisma.groundTruthCase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        caseType: GroundTruthCaseType.VALIDATION,
        submissionRelation: 'DIFFERENT',
        validationStatus: 'EXACT',
      }),
    });
  });
});
