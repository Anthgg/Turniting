import { BadRequestException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiService } from '../src/ai/ai.service.js';
import { AppModule } from '../src/app.module.js';
import { configureApplication } from '../src/common/configure-application.js';
import { DatasetService } from '../src/datasets/dataset.service.js';
import { GroundTruthDatasetService } from '../src/datasets/ground-truth-dataset.service.js';
import { ModelVersionService } from '../src/datasets/model-version.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const datasetId = '3f6b2a41-7c0e-4d8a-9b1f-2a3c4d5e6f70';
const caseId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

describe('Dataset API routes', () => {
  let app: INestApplication<App>;
  const prisma = { $queryRaw: vi.fn() };
  const aiService = { checkHealth: vi.fn(), analyzeTest: vi.fn() };
  const datasets = {
    list: vi.fn(), register: vi.fn(), getById: vi.fn(), getSources: vi.fn(), getArtifacts: vi.fn(),
    getStatistics: vi.fn(), listSamples: vi.fn(), importManifest: vi.fn(),
  };
  const groundTruth = { importCase: vi.fn() };
  const models = { list: vi.fn(), getById: vi.fn(), register: vi.fn(), importRegistry: vi.fn(), importF006Registry: vi.fn() };

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService).useValue(prisma)
      .overrideProvider(AiService).useValue(aiService)
      .overrideProvider(DatasetService).useValue(datasets)
      .overrideProvider(GroundTruthDatasetService).useValue(groundTruth)
      .overrideProvider(ModelVersionService).useValue(models)
      .compile();
    app = moduleFixture.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  beforeEach(() => vi.clearAllMocks());

  afterAll(async () => {
    await app?.close();
  });

  it('registers TURNITING_DATASET_V1 from training manifests', async () => {
    datasets.register.mockResolvedValue({ id: datasetId, status: 'READY' });
    const response = await request(app.getHttpServer())
      .post('/api/datasets/register')
      .send({ name: 'TURNITING_DATASET', version: 'V1', manifestPath: 'datasets/manifests',
        statisticsPath: 'reports/dataset_statistics.json' })
      .expect(201);
    expect(response.body.status).toBe('READY');
    expect(datasets.register).toHaveBeenCalledWith(expect.objectContaining({ name: 'TURNITING_DATASET', version: 'V1' }));
  });

  it('rejects path traversal and malformed names before reaching the service', async () => {
    await request(app.getHttpServer())
      .post('/api/datasets/register')
      .send({ name: 'TURNITING_DATASET', version: 'V1', manifestPath: '../../etc' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/datasets/register')
      .send({ name: 'lowercase', version: '1' })
      .expect(400);
    expect(datasets.register).not.toHaveBeenCalled();
  });

  it('lists datasets and returns detail, sources, statistics and artifacts', async () => {
    datasets.list.mockResolvedValue({ items: [{ id: datasetId }], page: 1, limit: 20, total: 1, totalPages: 1 });
    datasets.getById.mockResolvedValue({ id: datasetId, displayName: 'TURNITING_DATASET_V1' });
    datasets.getSources.mockResolvedValue([{ name: 'raid', licenseStatus: 'ALLOWED' }]);
    datasets.getStatistics.mockResolvedValue({ counts: { totalRows: 1338257 } });
    datasets.getArtifacts.mockResolvedValue([{ artifactType: 'MANIFEST' }]);

    await request(app.getHttpServer()).get('/api/datasets').expect(200);
    const detail = await request(app.getHttpServer()).get(`/api/datasets/${datasetId}`).expect(200);
    expect(detail.body.displayName).toBe('TURNITING_DATASET_V1');
    await request(app.getHttpServer()).get(`/api/datasets/${datasetId}/sources`).expect(200);
    const stats = await request(app.getHttpServer()).get(`/api/datasets/${datasetId}/statistics`).expect(200);
    expect(stats.body.counts.totalRows).toBe(1338257);
    await request(app.getHttpServer()).get(`/api/datasets/${datasetId}/artifacts`).expect(200);
    await request(app.getHttpServer()).get('/api/datasets/not-a-uuid').expect(400);
  });

  it('filters samples with validated query parameters', async () => {
    datasets.listSamples.mockResolvedValue({ items: [], page: 1, limit: 10, total: 0, totalPages: 0 });
    await request(app.getHttpServer())
      .get(`/api/datasets/${datasetId}/samples?label=MACHINE&labelSource=TURNITIN_AI_FLAGGED&eligibleForTraining=true&limit=10`)
      .expect(200);
    expect(datasets.listSamples).toHaveBeenCalledWith(datasetId, expect.objectContaining({
      label: 'MACHINE', labelSource: 'TURNITIN_AI_FLAGGED', eligibleForTraining: true, limit: 10,
    }));
    await request(app.getHttpServer()).get(`/api/datasets/${datasetId}/samples?label=ROBOT`).expect(400);
  });

  it('surfaces invalid manifests as 400', async () => {
    datasets.importManifest.mockRejectedValue(new BadRequestException({ message: 'Invalid training manifest', issues: ['x'] }));
    const response = await request(app.getHttpServer())
      .post(`/api/datasets/${datasetId}/import-manifest`)
      .send({ manifestPath: 'datasets/manifests' })
      .expect(400);
    expect(JSON.stringify(response.body)).toContain('Invalid training manifest');
  });

  it('imports synthetic ground truth without HUMAN samples', async () => {
    groundTruth.importCase.mockResolvedValue({ machineSamplesCreated: 2, humanSamplesCreated: 0, notFlaggedSkipped: 2 });
    const response = await request(app.getHttpServer())
      .post(`/api/datasets/${datasetId}/import-ground-truth/${caseId}`)
      .expect(201);
    expect(response.body).toEqual({ machineSamplesCreated: 2, humanSamplesCreated: 0, notFlaggedSkipped: 2 });
    expect(groundTruth.importCase).toHaveBeenCalledWith(datasetId, caseId);
  });

  it('registers a model candidate and imports the model registry', async () => {
    models.register.mockResolvedValue({ name: 'CANDIDATE_MODEL_V2', status: 'CANDIDATE' });
    await request(app.getHttpServer())
      .post('/api/model-versions/register')
      .send({ name: 'CANDIDATE_MODEL_V2', architecture: 'microsoft/mdeberta-v3-base', modelType: 'TRANSFORMER',
        status: 'CANDIDATE', commercialEligibility: 'RESEARCH_ONLY', metrics: { test_macro_f1: 0.8889 },
        datasetVersionId: datasetId })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/model-versions/register')
      .send({ name: 'CANDIDATE_MODEL_V2', architecture: 'x', modelType: 'TRANSFORMER', status: 'PRODUCTION',
        commercialEligibility: 'RESEARCH_ONLY', metrics: {} })
      .expect(400);
    models.importRegistry.mockResolvedValue({ registered: 2 });
    await request(app.getHttpServer())
      .post('/api/model-versions/import-registry')
      .send({ datasetVersionId: datasetId })
      .expect(201);
    expect(models.importRegistry).toHaveBeenCalledWith(expect.objectContaining({ datasetVersionId: datasetId }));
    models.importF006Registry.mockResolvedValue({ registered: 1, artifactAvailableLocally: false });
    const f006 = await request(app.getHttpServer()).post('/api/model-versions/import-f006-registry').expect(201);
    expect(f006.body).toMatchObject({ registered: 1, artifactAvailableLocally: false });
    expect(models.importF006Registry).toHaveBeenCalledOnce();
  });
});
