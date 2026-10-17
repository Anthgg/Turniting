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
import { ModelVersionService } from './model-version.service.js';
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

  beforeEach(() => {
    prisma = {
      datasetVersion: { findUnique: vi.fn().mockResolvedValue({ id: datasetId, name: 'SYNTHETIC_DATASET', version: 'V1' }) },
      modelVersion: {
        upsert: vi.fn().mockImplementation(async ({ create }) => ({ id: `id-${create.name}`, ...create })),
        findUnique: vi.fn().mockImplementation(async ({ where }) => ({ id: where.id, artifacts: [{ sizeBytes: 2048n }] })),
        findMany: vi.fn().mockResolvedValue([]),
      },
      datasetArtifact: { deleteMany: vi.fn(), create: vi.fn() },
    };
    service = new ModelVersionService(prisma as unknown as PrismaService, files());
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
});
