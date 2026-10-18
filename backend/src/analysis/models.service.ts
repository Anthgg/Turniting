import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AiService, type AiAnalyzerModelStatus } from '../ai/ai.service.js';
import { ModelVersionService } from '../datasets/model-version.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ACTIVE_ACCEPTANCE_LIMITS, MODEL_CATALOG, numericGateResults } from './model-catalog.js';

const ANALYZER_MODELS = [
  'ENSEMBLE_V2_V3',
  'CANDIDATE_MODEL_V3',
  'CANDIDATE_MODEL_V2',
  'EXPERIMENTAL_F006_1_MODEL',
  'EXPERIMENTAL_F006_MODEL',
  'BEST_BASELINE',
];
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
    const liveByName = new Map(live.map((model) => [model.model, model]));
    const ensembleComponents = [liveByName.get('CANDIDATE_MODEL_V2'), liveByName.get('CANDIDATE_MODEL_V3')];
    const ensembleReady = ensembleComponents.every((model) =>
      Boolean(model?.servable && ['AVAILABLE', 'READY'].includes(model.state)),
    );
    const ensembleAvailability = !aiReachable
      ? 'AI_SERVICE_UNREACHABLE'
      : ensembleReady
        ? 'COMPOSITE_AVAILABLE'
        : 'DEPENDENCIES_UNAVAILABLE';
    const items = ANALYZER_MODELS.map((name) => {
      const db = registered.find((m) => m.name === name);
      const st = liveByName.get(name);
      const defaults = MODEL_CATALOG[name];
      const isEnsemble = name === 'ENSEMBLE_V2_V3';
      const artifactPresent = isEnsemble
        ? ensembleComponents.every((model) => Boolean(model?.artifactPresent))
        : st?.artifactPresent ?? false;
      const artifactValid = isEnsemble
        ? ensembleComponents.every((model) => Boolean(model?.artifactValid))
        : st?.artifactValid ?? false;
      const missing = isEnsemble
        ? ensembleComponents.flatMap((model) => model?.missing ?? [])
        : st?.missing ?? [];
      const availability = !aiReachable
        ? 'AI_SERVICE_UNREACHABLE'
        : isEnsemble
          ? ensembleAvailability
          : st?.state ?? 'UNAVAILABLE';
      return {
        name,
        id: db?.id ?? null,
        registeredInDatabase: Boolean(db),
        registeredInRegistry: Boolean(defaults) || Boolean(st?.registered),
        status: db?.status ?? st?.status ?? defaults.status,
        architecture: db?.architecture ?? st?.architecture ?? defaults.architecture,
        variant: db?.variant ?? st?.variant ?? defaults.variant,
        dataset: st?.dataset ?? defaults.dataset,
        artifactProvider: db?.artifactProvider ?? st?.artifactProvider ?? defaults.artifactProvider,
        availability,
        available: st?.available ?? false,
        active: st?.active ?? defaults.researchMetadata?.active ?? false,
        candidate: st?.candidate ?? (defaults.status === 'CANDIDATE'),
        artifactPresent,
        artifactValid,
        missing,
        servable: isEnsemble ? ensembleReady : st?.servable ?? false,
        thresholdProfiles: st?.thresholdProfiles?.length ? st.thresholdProfiles : defaults.thresholdProfiles,
        thresholdSource: st?.thresholdSource ?? defaults.thresholdSource,
        preprocessing: st?.preprocessing?.length ? st.preprocessing : defaults.preprocessing,
        metrics: defaults.metrics,
        registryMetrics: db?.metrics ?? null,
        strengths: defaults.strengths,
        warnings: [...new Set([...(defaults.warnings ?? []), ...(st?.warnings ?? []), ...(db?.limitations ?? [])])],
        activeGateResults: numericGateResults(defaults.metrics),
        officialGateResults: defaults.officialGates,
        promotionEvidence: defaults.promotionEvidence,
        researchMetadata: defaults.researchMetadata,
        promotionEligible: false,
        promotionReviewRequired: true,
      };
    });
    return {
      aiServiceReachable: aiReachable,
      activeModel: 'NONE',
      recommendedExperimentalAnalyzer: 'ENSEMBLE_V2_V3',
      recommendedExperimentalThresholdProfile: 'BALANCED',
      lowFprAlternative: 'CANDIDATE_MODEL_V2',
      lowFprAlternativeThresholdProfile: 'LOW_FALSE_POSITIVE',
      promotionReviewRequired: true,
      activeAcceptanceLimits: ACTIVE_ACCEPTANCE_LIMITS,
      items,
    };
  }

  async metrics(idOrName: string) {
    const model = await this.prisma.modelVersion.findUnique({
      where: UUID.test(idOrName) ? { id: idOrName } : { name: idOrName },
    });
    if (!model) throw new NotFoundException('Model not registered');
    const metadata = (model.metadata ?? {}) as Prisma.JsonObject;
    const researchMetadata = MODEL_CATALOG[model.name]?.researchMetadata;
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
      sourceCommit: metadata.sourceCommit ?? researchMetadata?.sourceCommit ?? null,
      trainingPhase: metadata.trainingPhase ?? researchMetadata?.trainingPhase ?? null,
      gatesPassed: metadata.gatesPassed ?? researchMetadata?.gatesPassed ?? null,
      gatesTotal: metadata.gatesTotal ?? researchMetadata?.gatesTotal ?? null,
      failedGates: metadata.failedGates ?? researchMetadata?.failedGates ?? [],
      active: metadata.active ?? researchMetadata?.active ?? false,
      candidate: metadata.candidate ?? researchMetadata?.candidate ?? false,
      researchMetadata: researchMetadata ?? null,
    };
  }

  importV3Registry() {
    return this.registry.importAnalyzerRegistry();
  }
}
