import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  CommercialUseStatus,
  DatasetArtifactType,
  DatasetSourceStatus,
  DatasetSplit,
  DatasetStatus,
  GroundTruthCaseType,
  LabelSource,
  LicenseStatus,
  ModelStatus,
  PrivacyClass,
  TrainingLabel,
  TurnitinReportType,
  TurnitinSegmentType,
} from '@prisma/client';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { DatasetRepository } from './dataset.repository.js';
import { DatasetService, licenseWarnings, redactSample } from './dataset.service.js';
import { GroundTruthDatasetService, sampleTextHash } from './ground-truth-dataset.service.js';
import {
  classifyLicense,
  validateLicenses,
  validateModelRegistry,
  validateSplitManifest,
  validateStatistics,
} from './manifest-schemas.js';
import { ModelPromotionService } from './model-promotion.service.js';
import { F006_MODEL_REGISTRY, ModelVersionService } from './model-version.service.js';
import { TrainingFilesService } from './training-files.service.js';

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/datasets');
const datasetId = '3f6b2a41-7c0e-4d8a-9b1f-2a3c4d5e6f70';
const caseId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

function files() {
  const config = { getOrThrow: () => fixtureDir } as unknown as ConfigService;
  return new TrainingFilesService(config);
}

function versionRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: datasetId,
    name: 'SYNTHETIC_DATASET',
    version: 'V1',
    status: DatasetStatus.DRAFT,
    metadata: null,
    splitManifests: [],
    modelVersions: [],
    _count: { sources: 0, artifacts: 0, samples: 0 },
    ...overrides,
  };
}

describe('licence classification', () => {
  it.each([
    ['CC-BY-NC-ND-4.0', undefined, LicenseStatus.NON_COMMERCIAL_ONLY, CommercialUseStatus.NOT_ALLOWED],
    ['CC-BY-NC-SA-4.0', 'INCLUDED', LicenseStatus.NON_COMMERCIAL_ONLY, CommercialUseStatus.NOT_ALLOWED],
    ['MIT', 'INCLUDED', LicenseStatus.ALLOWED, CommercialUseStatus.ALLOWED],
    ['Apache-2.0', 'INCLUDED', LicenseStatus.ALLOWED, CommercialUseStatus.ALLOWED],
    ['CC-BY-3.0', 'INCLUDED', LicenseStatus.ALLOWED, CommercialUseStatus.ALLOWED],
    ['Not declared in repository (public research benchmark)', 'INCLUDED', LicenseStatus.UNDECLARED, CommercialUseStatus.UNCLEAR],
    ['CC-BY-4.0 (per Zenodo metadata)', 'BLOCKED_ACCESS', LicenseStatus.BLOCKED, CommercialUseStatus.UNCLEAR],
    ['', undefined, LicenseStatus.UNKNOWN, CommercialUseStatus.UNCLEAR],
  ])('%s (%s)', (license, status, licenseStatus, commercial) => {
    expect(classifyLicense(license, status)).toEqual({ licenseStatus, commercialUseStatus: commercial });
  });

  it('builds a visible non-commercial warning', () => {
    const warning = licenseWarnings([
      { name: 'iber', status: 'INCLUDED', licenseStatus: 'NON_COMMERCIAL_ONLY', commercialUseStatus: 'NOT_ALLOWED' },
      { name: 'multitude', status: 'BLOCKED_ACCESS', licenseStatus: 'BLOCKED', commercialUseStatus: 'UNCLEAR' },
    ]);
    expect(warning.message).toBe('Este dataset/modelo incluye fuentes con restricciones no comerciales.');
    expect(warning.blocked).toEqual(['multitude']);
  });
});

describe('manifest validation', () => {
  it('rejects licences without required fields', () => {
    expect(() => validateLicenses({ datasets: [{ dataset: 'x' }] })).toThrow(BadRequestException);
    expect(() => validateLicenses([])).toThrow(BadRequestException);
  });

  it('rejects statistics with negative or missing counts', () => {
    expect(() => validateStatistics({ datasetVersion: 'X', human: -1 })).toThrow(BadRequestException);
  });

  it('rejects unknown split names and bad hashes', () => {
    expect(() => validateSplitManifest({
      datasetVersion: 'X', sha256: 'nothex', rows: 1, split_counts: { holdout_secret: 1 },
    })).toThrow(BadRequestException);
  });

  it('rejects ACTIVE models and URL artifact paths in a registry', () => {
    const base = {
      name: 'MODEL_X', architecture: 'a', modelType: 'BASELINE', commercialEligibility: 'RESEARCH_ONLY', metrics: {},
    };
    expect(() => validateModelRegistry({ modelRegistrySchemaVersion: 1, datasetVersion: 'X', models: [{ ...base, status: 'ACTIVE' }] }))
      .toThrow(BadRequestException);
    expect(() => validateModelRegistry({
      modelRegistrySchemaVersion: 1, datasetVersion: 'X',
      models: [{ ...base, status: 'CANDIDATE', artifact: { provider: 'GOOGLE_DRIVE', path: 'https://drive.google.com/x?token=abc' } }],
    })).toThrow(BadRequestException);
    expect(() => validateModelRegistry({ modelRegistrySchemaVersion: 2, datasetVersion: 'X', models: [] }))
      .toThrow(BadRequestException);
  });
});

describe('TrainingFilesService', () => {
  it('refuses paths outside TRAINING_DIR', () => {
    const service = files();
    expect(() => service.resolve('../secrets.json')).toThrow(BadRequestException);
    expect(() => service.resolve('/etc/passwd')).toThrow(BadRequestException);
    expect(service.resolve('datasets/manifests/licenses.json')).toContain('licenses.json');
  });

  it('fingerprints local files with SHA-256 and returns null for missing ones', async () => {
    const service = files();
    const print = await service.fingerprint('datasets/manifests/licenses.json');
    expect(print?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await service.fingerprint('datasets/manifests/missing.json')).toBeNull();
  });
});

describe('DatasetService.importManifest', () => {
  let repository: Record<string, ReturnType<typeof vi.fn>>;
  let service: DatasetService;

  beforeEach(() => {
    repository = {
      findVersion: vi.fn().mockResolvedValue(versionRecord()),
      findVersionByNameVersion: vi.fn(),
      createVersion: vi.fn(),
      listSources: vi.fn().mockResolvedValue([]),
      replaceManifestData: vi.fn().mockImplementation(async (_id, version) => ({ id: datasetId, ...version })),
    };
    service = new DatasetService(repository as unknown as DatasetRepository, files());
  });

  it('imports sources, splits and artifacts from manifests without reading parquet rows', async () => {
    const result = await service.importManifest(datasetId, {});
    const [, version, sources, splits, artifacts] = repository.replaceManifestData.mock.calls[0];

    expect(version.status).toBe(DatasetStatus.READY);
    expect(version).toMatchObject({ totalRows: 260, humanRows: 100, machineRows: 155, spanishRows: 70, academicRows: 40,
      languageCount: 2, domainCount: 2, generatorCount: 2, exactDuplicatesRemoved: 30, leakageStatus: 'PASS' });
    expect(sources).toHaveLength(4);
    const byName = Object.fromEntries(sources.map((s: { name: string }) => [s.name, s]));
    expect(byName.synthetic_es).toMatchObject({ licenseStatus: LicenseStatus.NON_COMMERCIAL_ONLY, spanishRows: 70, rowsUsed: 105,
      sha256: '1'.repeat(64) });
    expect(byName.synthetic_raid.sha256).toBeNull();
    expect(byName.synthetic_semeval.licenseStatus).toBe(LicenseStatus.UNDECLARED);
    expect(byName.synthetic_blocked).toMatchObject({ status: DatasetSourceStatus.BLOCKED_ACCESS, licenseStatus: LicenseStatus.BLOCKED,
      rowsUsed: null });
    expect(splits.map((s: { split: DatasetSplit }) => s.split)).toContain(DatasetSplit.OOD);
    expect(splits.find((s: { split: DatasetSplit }) => s.split === DatasetSplit.TRAIN).rowCount).toBe(150);
    const shards = artifacts.filter((a: { artifactType: DatasetArtifactType }) => a.artifactType === DatasetArtifactType.PARQUET_SHARD);
    expect(shards).toHaveLength(2);
    expect(shards.every((a: { external: boolean; sha256: string }) => a.external && /^[67]{64}$/.test(a.sha256))).toBe(true);
    const local = artifacts.filter((a: { external: boolean }) => !a.external);
    expect(local.length).toBeGreaterThanOrEqual(5);
    expect(local.every((a: { sha256: string }) => /^[0-9a-f]{64}$/.test(a.sha256))).toBe(true);
    expect(result.imported.sources).toBe(4);
  });

  it('rejects manifests that describe another dataset version', async () => {
    repository.findVersion.mockResolvedValue(versionRecord({ name: 'OTHER_DATASET' }));
    await expect(service.importManifest(datasetId, {})).rejects.toThrow(BadRequestException);
    expect(repository.replaceManifestData).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown datasets', async () => {
    repository.findVersion.mockResolvedValue(null);
    await expect(service.importManifest(datasetId, {})).rejects.toThrow(NotFoundException);
  });

  it('redacts private sample text', () => {
    const sample = { id: 's', text: 'secret thesis paragraph', privacyClass: PrivacyClass.PRIVATE } as never;
    expect(redactSample(sample)).toMatchObject({ text: null, textRedacted: true });
    const synthetic = { id: 's', text: 'synthetic', privacyClass: PrivacyClass.SYNTHETIC } as never;
    expect(redactSample(synthetic)).toMatchObject({ text: 'synthetic', textRedacted: false });
  });
});

describe('GroundTruthDatasetService', () => {
  const segments = [
    { id: '11111111-1111-4111-8111-111111111111', segmentType: TurnitinSegmentType.AI_FLAGGED, text: 'Synthetic flagged passage one.', pageNumber: 1, segmentIndex: 0 },
    { id: '22222222-2222-4222-8222-222222222222', segmentType: TurnitinSegmentType.NOT_FLAGGED, text: 'Synthetic unflagged passage.', pageNumber: 1, segmentIndex: 1 },
    { id: '33333333-3333-4333-8333-333333333333', segmentType: TurnitinSegmentType.AI_FLAGGED, text: 'Synthetic flagged passage two.', pageNumber: 2, segmentIndex: 2 },
    { id: '44444444-4444-4444-8444-444444444444', segmentType: TurnitinSegmentType.NOT_FLAGGED, text: 'Another unflagged passage.', pageNumber: 2, segmentIndex: 3 },
  ];
  let prisma: {
    datasetVersion: { findUnique: ReturnType<typeof vi.fn> };
    groundTruthCase: { findUnique: ReturnType<typeof vi.fn> };
    turnitinSegment: { findMany: ReturnType<typeof vi.fn> };
    trainingSample: { createMany: ReturnType<typeof vi.fn> };
  };
  let service: GroundTruthDatasetService;

  function aiCase(overrides: Record<string, unknown> = {}) {
    return {
      id: caseId, name: 'SYNTHETIC_AI_CASE', caseType: GroundTruthCaseType.AI_REPORT, documentVersionId: null,
      aiReport: { id: 'r1', reportType: TurnitinReportType.AI_WRITING, documentVersionId: null, aiWritingScore: 50 },
      ...overrides,
    };
  }

  beforeEach(() => {
    prisma = {
      datasetVersion: { findUnique: vi.fn().mockResolvedValue({ id: datasetId }) },
      groundTruthCase: { findUnique: vi.fn().mockResolvedValue(aiCase()) },
      turnitinSegment: { findMany: vi.fn().mockResolvedValue(segments) },
      trainingSample: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
    };
    service = new GroundTruthDatasetService(prisma as unknown as PrismaService);
  });

  it('creates MACHINE candidates only from AI_FLAGGED and never HUMAN from NOT_FLAGGED', async () => {
    const result = await service.importCase(datasetId, caseId);
    const { data, skipDuplicates } = prisma.trainingSample.createMany.mock.calls[0][0];
    expect(skipDuplicates).toBe(true);
    expect(data).toHaveLength(2);
    expect(data.every((d: { label: TrainingLabel }) => d.label === TrainingLabel.MACHINE)).toBe(true);
    expect(data.some((d: { label: TrainingLabel }) => d.label === TrainingLabel.HUMAN)).toBe(false);
    expect(data[0]).toMatchObject({ labelSource: LabelSource.TURNITIN_AI_FLAGGED, privacyClass: PrivacyClass.PRIVATE,
      groundTruthCaseId: caseId, turnitinSegmentId: segments[0].id, textHash: sampleTextHash(segments[0].text) });
    expect(result).toMatchObject({ machineSamplesCreated: 2, humanSamplesCreated: 0, notFlaggedSkipped: 2 });
  });

  it('is idempotent: a second import creates nothing new', async () => {
    prisma.trainingSample.createMany.mockResolvedValue({ count: 0 });
    const result = await service.importCase(datasetId, caseId);
    expect(result).toMatchObject({ machineSamplesCreated: 0, alreadyImported: 2 });
  });

  it('refuses reserved validation cases and similarity reports', async () => {
    prisma.groundTruthCase.findUnique.mockResolvedValue(aiCase({ name: 'VALIDATION_CASE_001' }));
    await expect(service.importCase(datasetId, caseId)).rejects.toThrow(BadRequestException);
    prisma.groundTruthCase.findUnique.mockResolvedValue(aiCase({
      caseType: GroundTruthCaseType.SIMILARITY_REPORT, aiReport: null,
    }));
    await expect(service.importCase(datasetId, caseId)).rejects.toThrow(BadRequestException);
    prisma.groundTruthCase.findUnique.mockResolvedValue(aiCase({
      aiReport: { id: 'r2', reportType: TurnitinReportType.SIMILARITY, documentVersionId: null },
    }));
    await expect(service.importCase(datasetId, caseId)).rejects.toThrow(BadRequestException);
    expect(prisma.trainingSample.createMany).not.toHaveBeenCalled();
  });

  it('hashes text after conservative normalization', () => {
    expect(sampleTextHash('hola   mundo​')).toBe(sampleTextHash('hola mundo'));
  });
});

describe('ModelVersionService', () => {
  let prisma: Record<string, Record<string, ReturnType<typeof vi.fn>>>;
  let service: ModelVersionService;
  let trainingFiles: TrainingFilesService;

  beforeEach(() => {
    prisma = {
      datasetVersion: {
        findUnique: vi.fn().mockResolvedValue({ id: datasetId, name: 'SYNTHETIC_DATASET', version: 'V1' }),
        findFirst: vi.fn().mockResolvedValue({ id: datasetId, name: 'TURNITING_DATASET', version: 'V2' }),
      },
      modelVersion: {
        upsert: vi.fn().mockImplementation(async ({ create }) => ({ id: `id-${create.name}`, ...create })),
        findUnique: vi.fn().mockImplementation(async ({ where }) => ({ id: where.id, artifacts: [{ sizeBytes: 2048n }] })),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
      },
      datasetArtifact: { deleteMany: vi.fn(), create: vi.fn() },
    };
    trainingFiles = files();
    service = new ModelVersionService(prisma as unknown as PrismaService, trainingFiles, new ModelPromotionService());
  });

  it('imports the registry as CANDIDATE / RESEARCH_ONLY metadata with external weights', async () => {
    const result = await service.importRegistry({ datasetVersionId: datasetId });
    expect(result.registered).toBe(2);
    const candidate = prisma.modelVersion.upsert.mock.calls.find(([arg]) => arg.where.name === 'SYNTHETIC_CANDIDATE')![0];
    expect(candidate.create).toMatchObject({ status: ModelStatus.CANDIDATE, commercialEligibility: 'RESEARCH_ONLY',
      artifactProvider: 'GOOGLE_DRIVE', thresholds: { BALANCED: 0.505, LOW_FALSE_POSITIVE: 0.875, HIGH_PRECISION_AI: 0.585 } });
    const weights = prisma.datasetArtifact.create.mock.calls.map(([arg]) => arg.data);
    expect(weights.every((w: { artifactType: string; external: boolean }) => w.artifactType === 'MODEL_WEIGHTS' && w.external)).toBe(true);
    expect(result.models[0].artifacts[0].sizeBytes).toBe(2048);
  });

  it('rejects registries for a different dataset and ACTIVE registrations', async () => {
    prisma.datasetVersion.findUnique.mockResolvedValue({ id: datasetId, name: 'OTHER', version: 'V1' });
    await expect(service.importRegistry({ datasetVersionId: datasetId })).rejects.toThrow(BadRequestException);
    await expect(service.register({
      name: 'MODEL_X', architecture: 'a', modelType: 'BASELINE', status: ModelStatus.ACTIVE,
      commercialEligibility: 'RESEARCH_ONLY', metrics: {},
    } as never)).rejects.toThrow(BadRequestException);
  });

  it('imports F006 as experimental metadata without exposing the Drive path', async () => {
    const registry = {
      name: 'EXPERIMENTAL_F006_MODEL', baseModel: 'microsoft/mdeberta-v3-base',
      parentModel: 'CANDIDATE_MODEL_V3 (TURNITING_RESEARCH_V3_SPANISH_ACADEMIC)',
      datasetVersion: 'TURNITING_DATASET_V2', trainingStrategy: 'HARD_NEGATIVE_TARGETED_FINETUNE',
      status: 'EXPERIMENTAL', artifactProvider: 'GOOGLE_DRIVE_LOCAL_IMPORT',
      artifactPath: 'MyDrive/turniting/f006/models/experimental_v4', checkpointPath: 'MyDrive/turniting/f006/runs/F006_FULL/best',
      preprocessingVersion: 'V3_CANONICALIZED_V1', calibrationVersion: 'F006_ISOTONIC_V1',
      thresholds: { BALANCED: 0.8433, LOW_FALSE_POSITIVE: 0.7694, VERY_LOW_FALSE_POSITIVE: 0.8433 },
      selectedAnalyzer: 'V4_ONLY', metrics: { final_holdout_balanced: { all: { fpr: 0.0447 }, spanish: { fpr: 0.1423 } } },
      warnings: ['F006_GATES_FAILED: D_spanish_strong'], active: false,
    };
    const gates = {
      gates: {
        A_holdout_human_fpr_le_0_05: true, B_unseen_generator_fpr_le_0_10_or_clear_gain: true,
        C_academic_strong: true, D_spanish_strong: false, E_mixed_recall_drop_le_5pts: true,
        F_ai_edited_f1_drop_le_5pts: true, G_ood_no_severe_drop: true, H_zero_width_homoglyph_robust: true,
        I_no_leakage: true, J_holdout_never_used_for_tuning: true,
      },
      passed: false, status: 'EXPERIMENTAL', span_gate: true,
    };
    vi.spyOn(trainingFiles, 'readJson').mockImplementation(async (path) =>
      path === F006_MODEL_REGISTRY ? registry : gates);
    prisma.modelVersion.findUnique.mockResolvedValueOnce({
      id: 'id-f006', artifactProvider: 'GOOGLE_DRIVE', artifactPath: registry.artifactPath,
      artifacts: [{ storageProvider: 'GOOGLE_DRIVE', path: registry.artifactPath, sizeBytes: 2048n }],
    });

    const result = await service.importF006Registry();
    const upsert = prisma.modelVersion.upsert.mock.calls[0][0];
    expect(result).toMatchObject({ registered: 1, datasetVersion: 'TURNITING_DATASET_V2', datasetLinked: true,
      artifactAvailableLocally: false });
    expect(upsert.create).toMatchObject({
      name: 'EXPERIMENTAL_F006_MODEL', architecture: 'microsoft/mdeberta-v3-base',
      status: ModelStatus.EXPERIMENTAL, modelType: 'TRANSFORMER', commercialEligibility: 'RESEARCH_ONLY',
      artifactProvider: 'GOOGLE_DRIVE', artifactPath: registry.artifactPath,
      metadata: { parentModel: registry.parentModel, trainingStrategy: registry.trainingStrategy,
        active: false, gatesPassed: 9, gatesTotal: 10 },
    });
    expect(prisma.datasetArtifact.create.mock.calls[0][0].data).toMatchObject({
      storageProvider: 'GOOGLE_DRIVE', external: true,
      metadata: { downloaded: false },
    });
    expect(result.model.artifactPath).toBeNull();
    expect(result.model.artifacts[0].path).toBeNull();
    expect(JSON.stringify(result)).not.toContain('MyDrive');
  });

  it('imports F006.1 as experimental external metadata without linking a dataset', async () => {
    const { readFileSync } = await import('node:fs');
    const registry = JSON.parse(readFileSync(
      new URL('../../../training/datasets/manifests/model_registry_f006_1.json', import.meta.url),
      'utf8',
    ));
    vi.spyOn(trainingFiles, 'readJson').mockResolvedValue(registry);
    prisma.modelVersion.findUnique.mockResolvedValueOnce({
      id: 'id-EXPERIMENTAL_F006_1_MODEL',
      name: 'EXPERIMENTAL_F006_1_MODEL',
      status: ModelStatus.EXPERIMENTAL,
      datasetVersionId: null,
      artifactPath: 'MyDrive/turniting/f006_1/models/experimental_f006_1',
      artifacts: [{ sizeBytes: 2048n, path: 'MyDrive/turniting/f006_1/models/experimental_f006_1' }],
    });

    const result = await service.importF0061Registry();
    const upsert = prisma.modelVersion.upsert.mock.calls[0][0];
    expect(result).toMatchObject({
      registered: 1,
      datasetVersion: 'F006_1_EXTERNAL',
      datasetLinked: false,
      model: {
        status: ModelStatus.EXPERIMENTAL,
        datasetVersionId: null,
        artifactPath: null,
        artifacts: [{ path: null, sizeBytes: 2048 }],
      },
    });
    expect(upsert.create).toMatchObject({
      name: 'EXPERIMENTAL_F006_1_MODEL',
      status: ModelStatus.EXPERIMENTAL,
      modelType: 'TRANSFORMER',
      datasetVersionId: null,
      artifactProvider: 'GOOGLE_DRIVE',
      artifactPath: 'MyDrive/turniting/f006_1/models/experimental_f006_1',
      metadata: {
        active: false,
        candidate: false,
        datasetVersionId: null,
        sourceCommit: '714cdafe39977002ee9b84791a4bd8dca05cc57a',
        gatesPassed: 7,
        gatesTotal: 11,
      },
    });
    expect(prisma.datasetVersion.findUnique).not.toHaveBeenCalled();
    expect(prisma.datasetArtifact.create.mock.calls[0][0].data).toMatchObject({
      storageProvider: 'GOOGLE_DRIVE',
      external: true,
      metadata: { downloaded: false },
    });
  });

  it('blocks F006 promotion even with an explicit review when Spanish FPR fails', async () => {
    prisma.modelVersion.findUnique.mockResolvedValueOnce({
      id: 'id-f006', name: 'EXPERIMENTAL_F006_MODEL', status: ModelStatus.EXPERIMENTAL,
      metadata: null, artifacts: [],
    });
    const review = {
      approved: true,
      reviewer: 'reviewer-1',
      reviewedAt: '2026-10-17T12:00:00.000Z',
      rationale: 'Explicit review for the F006 promotion policy test.',
    };
    let error: unknown;
    try {
      await service.promoteToActive('EXPERIMENTAL_F006_MODEL', review);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      promotion: { decision: 'BLOCKED', eligible: false, criteria: {
        spanishHumanFpr: { state: 'FAIL', observed: 0.1423, limit: 0.08 },
        paragraphStability: { state: 'NOT_EVALUATED' },
        explicitReview: { state: 'PASS' },
      } },
    });
    expect(prisma.modelVersion.update).not.toHaveBeenCalled();
  });
});
