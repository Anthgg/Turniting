import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatasetArtifactType, ModelStatus, Prisma, StorageProvider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ImportModelRegistryDto, RegisterModelVersionDto } from './dto/datasets.dto.js';
import {
  ManifestIssues,
  validateModelEntry,
  validateModelRegistry,
  type ModelRegistryEntry,
} from './manifest-schemas.js';
import { TrainingFilesService } from './training-files.service.js';

export const DEFAULT_MODEL_REGISTRY = 'datasets/manifests/model_registry.json';

/**
 * Metadata-only registry of trained models. Weights are never loaded or downloaded here,
 * and registration can never mark a model ACTIVE (production activation is a later phase).
 */
@Injectable()
export class ModelVersionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: TrainingFilesService,
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

function serialize<T extends { artifacts: Array<{ sizeBytes: bigint | null }> }>(model: T) {
  return { ...model, artifacts: model.artifacts.map((a) => ({ ...a, sizeBytes: a.sizeBytes === null ? null : Number(a.sizeBytes) })) };
}
