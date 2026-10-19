/** Future research contracts only; these types do not register or run a model. */
export type UnifiedComponentModelId =
  | 'ENSEMBLE_V2_V3'
  | 'EXPERIMENTAL_F006_1_MODEL'
  | 'EXPERIMENTAL_F006_1_1_MODEL';

export type UnifiedComponentReference = {
  modelId: UnifiedComponentModelId;
  modelVersion: string;
};

export type UnifiedArtifactReference = {
  id: string;
  version: string;
  sha256: string;
  /** Research defines the schema and format before a loader is implemented. */
  format: string;
};

export type UnifiedModelConfig = {
  id: 'TURNITING_UNIFIED_EXPERIMENTAL_V1';
  version: string;
  components: readonly UnifiedComponentReference[];
  metaModelArtifact?: UnifiedArtifactReference;
  calibrationArtifact?: UnifiedArtifactReference;
  threshold?: number;
  status: 'EXPERIMENTAL';
  active: false;
  candidate: false;
};

export type ComponentScore = {
  modelId: UnifiedComponentModelId;
  modelVersion: string;
  rawScore: number;
  calibratedScore: number;
  threshold: number;
  languageCode: 'es' | 'en' | 'other';
};

export type UnifiedAnalysisResult = {
  modelId: UnifiedModelConfig['id'];
  unifiedScore: number;
  unifiedThreshold: number;
  flagged: boolean;
  componentScores: readonly ComponentScore[];
  componentModelIds: readonly UnifiedComponentModelId[];
  fusionVersion: string;
};

/** A future cache encoder must include every field, with components ordered by model ID. */
export type UnifiedInferenceCacheIdentity = {
  fusionVersion: string;
  metaModelHash: string;
  calibrationArtifactHash: string;
  componentModelVersions: readonly UnifiedComponentReference[];
  profile: string;
  customThreshold?: number;
  languageCode: ComponentScore['languageCode'];
  paragraphMode: 'STRICT_PARAGRAPH' | 'CONTEXTUAL_PARAGRAPH';
  textHash: string;
};

export interface UnifiedArtifactLoader<TArtifact> {
  load(reference: UnifiedArtifactReference): Promise<TArtifact>;
}
