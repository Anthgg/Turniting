import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AiService, type AiAnalyzerModelStatus } from '../ai/ai.service.js';
import { ModelVersionService } from '../datasets/model-version.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const ANALYZER_MODELS = ['BEST_BASELINE', 'CANDIDATE_MODEL_V2', 'CANDIDATE_MODEL_V3'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Registry view for the analyzer: database metadata (F004 ModelVersion) + live artifact state
 * from the ai-service. Local filesystem paths and storage locations are never exposed.
 */
@Injectable()
export class AnalyzerModelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly registry: ModelVersionService,
  ) {}

  async list() {
    const registered = await this.prisma.modelVersion.findMany({ where: { name: { in: ANALYZER_MODELS } } });
    let live: AiAnalyzerModelStatus[] = [];
    let aiReachable = true;
    try {
      live = (await this.ai.listAnalyzerModels()).models;
    } catch {
      aiReachable = false;
    }
    const items = ANALYZER_MODELS.map((name) => {
      const db = registered.find((m) => m.name === name);
      const st = live.find((m) => m.model === name);
      return {
        name,
        id: db?.id ?? null,
        registeredInDatabase: Boolean(db),
        status: db?.status ?? st?.status ?? null,
        architecture: db?.architecture ?? st?.architecture ?? null,
        variant: db?.variant ?? st?.variant ?? null,
        dataset: st?.dataset ?? null,
        artifactProvider: db?.artifactProvider ?? st?.artifactProvider ?? null,
        availability: !aiReachable ? 'AI_SERVICE_UNREACHABLE' : (st?.state ?? 'UNAVAILABLE'),
        artifactPresent: st?.artifactPresent ?? false,
        servable: st?.servable ?? false,
        thresholdProfiles: st?.thresholdProfiles ?? [],
        thresholdSource: st?.thresholdSource ?? null,
        preprocessing: st?.preprocessing ?? [],
        warnings: [...new Set([...(st?.warnings ?? []), ...(db?.limitations ?? [])])],
      };
    });
    return { aiServiceReachable: aiReachable, items };
  }

  async metrics(idOrName: string) {
    const model = await this.prisma.modelVersion.findUnique({
      where: UUID.test(idOrName) ? { id: idOrName } : { name: idOrName },
    });
    if (!model) throw new NotFoundException('Model not registered');
    const metadata = (model.metadata ?? {}) as Prisma.JsonObject;
    return {
      id: model.id,
      name: model.name,
      status: model.status,
      variant: model.variant,
      metrics: model.metrics,
      thresholds: model.thresholds,
      calibration: model.calibration,
      limitations: model.limitations,
      warnings: metadata.warnings ?? [],
    };
  }

  importV3Registry() {
    return this.registry.importAnalyzerRegistry();
  }
}
