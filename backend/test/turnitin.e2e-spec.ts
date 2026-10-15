import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiService } from '../src/ai/ai.service.js';
import { configureApplication } from '../src/common/configure-application.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TurnitinService } from '../src/turnitin/turnitin.service.js';

const reportId = 'b12a8b36-4bf4-4cbe-86ef-873ff7fbc0da';
const aiReportId = 'a6ee5ef8-2d25-41e7-89f8-5c9c57f9422a';

describe('Turnitin API routes', () => {
  let app: INestApplication<App>;
  const prisma = { $queryRaw: vi.fn() };
  const aiService = { checkHealth: vi.fn(), analyzeTest: vi.fn() };
  const turnitinService = {
    upload: vi.fn(),
    list: vi.fn(),
    getById: vi.fn(),
    getSources: vi.fn(),
    getSegments: vi.fn(),
    reparse: vi.fn(),
    match: vi.fn(),
    remove: vi.fn(),
    createGroundTruthCase: vi.fn(),
    listGroundTruthCases: vi.fn(),
    getGroundTruthCase: vi.fn(),
    updateGroundTruthCase: vi.fn(),
  };

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(AiService)
      .useValue(aiService)
      .overrideProvider(TurnitinService)
      .useValue(turnitinService)
      .compile();

    app = moduleFixture.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('routes a multipart PDF upload through the report service', async () => {
    turnitinService.upload.mockResolvedValue({ id: reportId, reportType: 'AI_WRITING' });

    const response = await request(app.getHttpServer())
      .post('/api/turnitin/reports')
      .attach('file', Buffer.from('%PDF-1.7 synthetic'), {
        filename: 'synthetic-report.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);

    expect(response.body).toEqual({ id: reportId, reportType: 'AI_WRITING' });
    expect(turnitinService.upload).toHaveBeenCalledWith(
      expect.objectContaining({ originalname: 'synthetic-report.pdf', mimetype: 'application/pdf' }),
    );
  });

  it('validates pagination and routes segment filtering', async () => {
    turnitinService.getSegments.mockResolvedValue({
      items: [], page: 2, limit: 10, total: 0, totalPages: 0,
    });

    await request(app.getHttpServer())
      .get(`/api/turnitin/reports/${reportId}/segments?page=2&limit=10&segmentType=AI_FLAGGED`)
      .expect(200, { items: [], page: 2, limit: 10, total: 0, totalPages: 0 });

    expect(turnitinService.getSegments).toHaveBeenCalledWith(reportId, {
      page: 2, limit: 10, segmentType: 'AI_FLAGGED',
    });
    await request(app.getHttpServer())
      .get(`/api/turnitin/reports/${reportId}/segments?page=0`)
      .expect(400);
  });

  it('routes a typed ground truth creation request', async () => {
    turnitinService.createGroundTruthCase.mockResolvedValue({
      id: reportId,
      name: 'SYNTHETIC_AI_CASE',
      caseType: 'AI_REPORT',
      aiReportId,
    });

    await request(app.getHttpServer())
      .post('/api/turnitin/ground-truth')
      .send({ name: 'SYNTHETIC_AI_CASE', caseType: 'AI_REPORT', aiReportId })
      .expect(201, {
        id: reportId,
        name: 'SYNTHETIC_AI_CASE',
        caseType: 'AI_REPORT',
        aiReportId,
      });
    expect(turnitinService.createGroundTruthCase).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'SYNTHETIC_AI_CASE', caseType: 'AI_REPORT', aiReportId }),
    );
  });
});
