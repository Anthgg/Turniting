import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CommercialEligibility,
  DatasetArtifactType,
  ModelStatus,
  ModelType,
  Prisma,
  StorageProvider,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ImportModelRegistryDto, RegisterModelVersionDto } from './dto/datasets.dto.js';
import {
  ManifestIssues,
  isObject,
  validateModelEntry,
  validateModelRegistry,
  type ModelRegistryEntry,
} from './manifest-schemas.js';
import { ModelPromotionService, type ModelPromotionReview } from './model-promotion.service.js';
import { TrainingFilesService } from './training-files.service.js';

export const DEFAULT_MODEL_REGISTRY = 'datasets/manifests/model_registry.json';
/** F005: CANDIDATE_MODEL_V3 (TURNITING_DATASET_V2) metadata, metrics and structural warnings. */
export const ANALYZER_MODEL_REGISTRY = 'datasets/manifests/model_registry_v3.json';
export const F006_MODEL_REGISTRY = 'datasets/manifests/model_registry_f006.json';
const F006_GATE_REPORT = 'reports/f006/gates.json';

/**
 * Metadata-only registry of trained models. Weights are never loaded or downloaded here,
 * and registration can never mark a model ACTIVE (production activation is a later phase).
 */
@Injectable()
export class ModelVersionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: TrainingFilesService,
    private readonly promotion: ModelPromotionService,
  ) {}

  list(datasetVersionId?: string) {
    return this.prisma.modelVersion.findMany({
      where: datasetVersionId ? { datasetVersionId } : undefined,
      orderBy: { createdAt: 'asc' },
      include: { artifacts: true },
    }).then((items) => items.map(serialize));
  }

  async getById(id: string) {
    const model = await this.prisma.modelVersion.findUnique({ where: { id }, include: { artifacts: true } });
    if (!model) throw new NotFoundException('Model version not found');
    return serialize(model);
  }

  async importRegistry(body: ImportModelRegistryDto) {
    const dataset = await this.prisma.datasetVersion.findUnique({ where: { id: body.datasetVersionId } });
    if (!dataset) throw new NotFoundException('Dataset version not found');
    const path = body.registryPath ?? DEFAULT_MODEL_REGISTRY;
    const registry = validateModelRegistry(await this.files.readJson(path));
    if (registry.datasetVersion !== `${dataset.name}_${dataset.version}`) {
      throw new BadRequestException(`model_registry.json targets ${registry.datasetVersion}, not ${dataset.name}_${dataset.version}`);
    }
    const models = [];
    for (const entry of registry.models) {
      models.push(await this.upsert(entry, dataset.id, `training/${path}`));
    }
    return { registered: models.length, models };
  }

  /**
   * Registers the models of a registry whose dataset version may not be registered in the
   * database yet (TURNITING_DATASET_V2 lives in Google Drive): they are linked when the
   * dataset exists and kept unlinked otherwise. Never marks a model ACTIVE.
   */
  async importAnalyzerRegistry(path = ANALYZER_MODEL_REGISTRY) {
    const registry = validateModelRegistry(await this.files.readJson(path));
    const cut = registry.datasetVersion.lastIndexOf('_');
    const dataset = await this.prisma.datasetVersion.findFirst({
      where: { name: registry.datasetVersion.slice(0, cut), version: registry.datasetVersion.slice(cut + 1) },
    });
    const models = [];
    for (const entry of registry.models) {
      models.push(await this.upsert(entry, dataset?.id ?? null, `training/${path}`));
    }
    return { registered: models.length, datasetVersion: registry.datasetVersion, datasetLinked: Boolean(dataset), models };
  }

  async importF006Registry() {
    const rawRegistry = await this.files.readJson(F006_MODEL_REGISTRY);
    const issues = new ManifestIssues(F006_MODEL_REGISTRY);
    issues.require(isObject(rawRegistry), 'must contain a model registry object');
    issues.throwIfAny();
    const source = rawRegistry as Record<string, unknown>;
    issues.require(source.name === 'EXPERIMENTAL_F006_MODEL', 'name must be EXPERIMENTAL_F006_MODEL');
    issues.require(source.baseModel === 'microsoft/mdeberta-v3-base', 'baseModel is invalid');
    issues.require(source.status === ModelStatus.EXPERIMENTAL, 'status must remain EXPERIMENTAL');
    issues.require(source.active === false, 'active must remain false');
    issues.require(source.datasetVersion === 'TURNITING_DATASET_V2', 'datasetVersion is invalid');
    issues.require(source.artifactProvider === 'GOOGLE_DRIVE_LOCAL_IMPORT', 'artifactProvider is invalid');
    issues.require(typeof source.artifactPath === 'string' && source.artifactPath.startsWith('MyDrive/'),
      'artifactPath must be a logical Drive path');
    issues.require(typeof source.parentModel === 'string' && source.parentModel.startsWith('CANDIDATE_MODEL_V3'),
      'parentModel must be CANDIDATE_MODEL_V3');
    issues.require(typeof source.trainingStrategy === 'string' && source.trainingStrategy.length > 0,
      'trainingStrategy is required');
    issues.require(isObject(source.metrics) && isObject(source.metrics.final_holdout_balanced),
      'metrics.final_holdout_balanced is required');
    issues.require(isObject(source.thresholds), 'thresholds are required');
    issues.require(Array.isArray(source.warnings) && source.warnings.includes('F006_GATES_FAILED: D_spanish_strong'),
      'warnings must record the failed Spanish gate');

    const rawGateReport = await this.files.readJson(F006_GATE_REPORT);
    issues.require(isObject(rawGateReport), 'official gate report must be an object');
    issues.throwIfAny();
    const gateReport = rawGateReport as Record<string, unknown>;
    const officialGates = gateReport.gates;
    issues.require(isObject(officialGates), 'official gate report must contain gates');
    if (isObject(officialGates)) {
      issues.require(Object.keys(officialGates).length === 10, 'official gate report must contain 10 gates');
      issues.require(officialGates.D_spanish_strong === false, 'D_spanish_strong must remain failed');
      issues.require(Object.entries(officialGates).filter(([, passed]) => passed === true).length === 9,
        'exactly 9 of 10 official gates must pass');
    }
    issues.require(gateReport.passed === false && gateReport.status === ModelStatus.EXPERIMENTAL,
      'official gate report must preserve the EXPERIMENTAL decision');
    issues.throwIfAny();

    const entry: ModelRegistryEntry = {
      name: 'EXPERIMENTAL_F006_MODEL',
      architecture: 'microsoft/mdeberta-v3-base',
      variant: 'F006_TRANSFORMER_EXPERIMENTAL_MULTI_TASK_HEADS',
      modelType: ModelType.TRANSFORMER,
      status: ModelStatus.EXPERIMENTAL,
      trainingEnvironment: 'Google Colab',
      commercialEligibility: CommercialEligibility.RESEARCH_ONLY,
      artifact: {
        provider: StorageProvider.GOOGLE_DRIVE,
        path: source.artifactPath as string,
        external: true,
        note: 'Logical external artifact reference; local weights are unavailable and were not downloaded.',
      },
      metrics: source.metrics as Record<string, unknown>,
      thresholds: source.thresholds as Record<string, number | null>,
      calibration: { version: source.calibrationVersion },
      limitations: [
        ...(source.warnings as string[]),
        'Spanish human false-positive rate is elevated.',
      ],
      metadata: {
        parentModel: source.parentModel,
        datasetVersion: source.datasetVersion,
        trainingStrategy: source.trainingStrategy,
        preprocessingVersion: source.preprocessingVersion,
        calibrationVersion: source.calibrationVersion,
        selectedAnalyzer: source.selectedAnalyzer,
        active: false,
        artifactAvailableLocally: false,
        officialGates,
        gatesPassed: 9,
        gatesTotal: 10,
        nextResearchStep: 'F006.1_SPANISH_GENERALIZATION',
      },
    };
    validateModelEntry(JSON.parse(JSON.stringify(entry)) as Record<string, unknown>, 'F006', issues);
    issues.throwIfAny();

    const datasetVersion = source.datasetVersion as string;
    const separator = datasetVersion.lastIndexOf('_');
    const dataset = await this.prisma.datasetVersion.findFirst({
      where: { name: datasetVersion.slice(0, separator), version: datasetVersion.slice(separator + 1) },
    });
    const model = await this.upsert(entry, dataset?.id ?? null, `training/${F006_MODEL_REGISTRY}`);
    return {
      registered: 1,
      datasetVersion,
      datasetLinked: Boolean(dataset),
      artifactAvailableLocally: false,
      model,
    };
  }

  async promoteToActive(name: string, review: ModelPromotionReview) {
    const model = await this.prisma.modelVersion.findUnique({ where: { name }, include: { artifacts: true } });
    if (!model) throw new NotFoundException('Model version not found');
    const promotion = this.promotion.evaluate(name, model.status, review);
    if (!promotion.eligible) {
      throw new BadRequestException({ message: 'Model promotion is blocked by acceptance gates', promotion });
    }
    const metadata = {
      ...((model.metadata ?? {}) as Prisma.JsonObject),
      promotionReview: { ...review, criteria: promotion.criteria },
    } as Prisma.InputJsonValue;
    const promoted = await this.prisma.modelVersion.update({
      where: { id: model.id },
      data: { status: ModelStatus.ACTIVE, metadata },
    });
    return this.getById(promoted.id);
  }

  async register(body: RegisterModelVersionDto) {
    const issues = new ManifestIssues('model registration');
    const plain = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    validateModelEntry(plain, 'body', issues);
    issues.throwIfAny();
    if (body.datasetVersionId) {
      const dataset = await this.prisma.datasetVersion.findUnique({ where: { id: body.datasetVersionId } });
      if (!dataset) throw new NotFoundException('Dataset version not found');
    }
    const entry: ModelRegistryEntry = {
      ...(plain as unknown as ModelRegistryEntry),
      artifact: body.artifactProvider && body.artifactPath
        ? { provider: body.artifactProvider, path: body.artifactPath, external: body.artifactProvider !== StorageProvider.REPOSITORY }
        : undefined,
    };
    return this.upsert(entry, body.datasetVersionId ?? null, 'api');
  }

  private async upsert(entry: ModelRegistryEntry, datasetVersionId: string | null, registeredFrom: string) {
    if (entry.status === ModelStatus.ACTIVE) {
      throw new BadRequestException('ACTIVE cannot be set by registration');
    }
    const data = {
      architecture: entry.architecture,
      variant: entry.variant ?? null,
      datasetVersionId,
      status: entry.status,
      modelType: entry.modelType,
      trainingEnvironment: entry.trainingEnvironment ?? null,
      commercialEligibility: entry.commercialEligibility,
      artifactProvider: entry.artifact?.provider ?? null,
      artifactPath: entry.artifact?.path ?? null,
      gitCommit: entry.gitCommit ?? null,
      metrics: entry.metrics as Prisma.InputJsonValue,
      thresholds: (entry.thresholds ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      calibration: (entry.calibration ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      limitations: entry.limitations ?? [],
      metadata: { ...entry.metadata, registeredFrom, artifactNote: entry.artifact?.note ?? null } as Prisma.InputJsonValue,
    };
    const model = await this.prisma.modelVersion.upsert({
      where: { name: entry.name },
      create: { name: entry.name, ...data },
      update: data,
    });
    if (entry.artifact) {
      await this.prisma.datasetArtifact.deleteMany({ where: { modelVersionId: model.id, artifactType: DatasetArtifactType.MODEL_WEIGHTS } });
      await this.prisma.datasetArtifact.create({
        data: {
          modelVersionId: model.id,
          artifactType: DatasetArtifactType.MODEL_WEIGHTS,
          storageProvider: entry.artifact.provider,
          path: entry.artifact.path,
          sizeBytes: entry.artifact.sizeBytes ? BigInt(entry.artifact.sizeBytes) : null,
          external: entry.artifact.external ?? true,
          metadata: { downloaded: false, note: entry.artifact.note ?? null },
        },
      });
    }
    return this.getById(model.id);
  }
}

function serialize<T extends {
  artifactProvider?: StorageProvider | null;
  artifactPath?: string | null;
  artifacts: Array<{
    sizeBytes: bigint | null;
    storageProvider?: StorageProvider;
    path?: string | null;
  }>;
}>(model: T) {
  return {
    ...model,
    artifactPath: null,
    artifacts: model.artifacts.map((artifact) => ({
      ...artifact,
      path: null,
      sizeBytes: artifact.sizeBytes === null ? null : Number(artifact.sizeBytes),
    })),
  };
}
