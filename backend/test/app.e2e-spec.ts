import { ServiceUnavailableException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiService } from '../src/ai/ai.service.js';
import { AnalysisService } from '../src/analysis/analysis.service.js';
import { configureApplication } from '../src/common/configure-application.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe('health endpoints', () => {
  let app: INestApplication<App>;
  const prisma = { $queryRaw: vi.fn() };
  const aiService = { checkHealth: vi.fn(), analyzeTest: vi.fn() };
  const analysisService = { quickAnalyze: vi.fn() };

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(AiService)
      .useValue(aiService)
      .overrideProvider(AnalysisService)
      .useValue(analysisService)
      .compile();

    app = moduleFixture.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  beforeEach(() => {
    prisma.$queryRaw.mockClear();
    aiService.checkHealth.mockClear();
    aiService.analyzeTest.mockClear();
    analysisService.quickAnalyze.mockReset();
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    aiService.checkHealth.mockResolvedValue({ status: 'ok', service: 'ai-service' });
    aiService.analyzeTest.mockResolvedValue({ status: 'ok', characters: 11, words: 2 });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves backend health at /api/health', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200, { status: 'ok', service: 'backend' });
  });

  it('runs the PostgreSQL health probe at /api/health/db', async () => {
    await request(app.getHttpServer()).get('/api/health/db').expect(200, { status: 'ok', database: 'connected' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('calls FastAPI at /api/health/ai and returns controlled 503 when unavailable', async () => {
    await request(app.getHttpServer()).get('/api/health/ai').expect(200, { status: 'ok', aiService: 'connected' });

    aiService.checkHealth.mockRejectedValueOnce(new ServiceUnavailableException('private AI error'));
    const response = await request(app.getHttpServer()).get('/api/health/ai').expect(503);
    expect(response.body.message).toBe('Service temporarily unavailable');
    expect(response.body).not.toHaveProperty('stack');
    expect(JSON.stringify(response.body)).not.toContain('private AI error');
  });

  it('forwards only the test text to FastAPI without persisting it', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/ai/analyze/test')
      .send({ text: 'hello world' })
      .expect(200);

    expect(response.body).toEqual({ status: 'ok', characters: 11, words: 2 });
    expect(aiService.analyzeTest).toHaveBeenCalledWith('hello world');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('rejects invalid or extra fields on the AI test contract route', async () => {
    await request(app.getHttpServer()).post('/api/ai/analyze/test').send({ text: 1 }).expect(400);
    await request(app.getHttpServer())
      .post('/api/ai/analyze/test')
      .send({ text: 'hello', unexpected: true })
      .expect(400);
    expect(aiService.analyzeTest).not.toHaveBeenCalled();
  });

  it('serves quick analysis through the ephemeral route and validates its input', async () => {
    const syntheticResult = {
      evaluated: true,
      scoredParagraphs: 1,
      insufficientParagraphs: 0,
      scientificThreshold: 0.6,
      reviewThreshold: 0.2,
      model: { id: 'CANDIDATE_MODEL_V3', displayName: 'Synthetic model', version: 'test' },
      languageCode: 'other',
      latencyMs: 1,
      paragraphs: [{ index: 0, status: 'LOW_SIGNAL', score: 0.25, scientificFlag: false, reviewHighlighted: true }],
    };
    analysisService.quickAnalyze.mockResolvedValueOnce(syntheticResult);

    await request(app.getHttpServer())
      .post('/api/analysis/quick')
      .send({ text: 'Synthetic paragraph for endpoint coverage.' })
      .expect(201, syntheticResult);

    expect(analysisService.quickAnalyze).toHaveBeenCalledWith({ text: 'Synthetic paragraph for endpoint coverage.' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('rejects unknown quick-analysis fields before the service is called', async () => {
    await request(app.getHttpServer())
      .post('/api/analysis/quick')
      .send({ text: 'Synthetic text.', documentId: 'unexpected' })
      .expect(400);

    expect(analysisService.quickAnalyze).not.toHaveBeenCalled();
  });
});
