import { BadRequestException } from '@nestjs/common';
import {
  CommercialEligibility,
  CommercialUseStatus,
  DatasetSourceStatus,
  DatasetSourceType,
  DatasetSplit,
  LicenseStatus,
  ModelStatus,
  ModelType,
  StorageProvider,
} from '@prisma/client';

/**
 * Versioned validators for the training manifests. Manifests are produced by
 * training/scripts/*; future versions may add fields, so unknown keys are kept
 * (in metadata) but required keys and their types are enforced.
 */
export const DATASET_MANIFEST_SCHEMA_VERSION = 1;
export const MODEL_REGISTRY_SCHEMA_VERSION = 1;

type Json = Record<string, unknown>;

export class ManifestIssues {
  private readonly issues: string[] = [];

  constructor(private readonly file: string) {}

  require(condition: unknown, message: string): boolean {
    if (!condition) {
      this.issues.push(`${this.file}: ${message}`);
    }
    return Boolean(condition);
  }

  throwIfAny(): void {
    if (this.issues.length) {
      throw new BadRequestException({ message: 'Invalid training manifest', issues: this.issues });
    }
  }
}

export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

// ------------------------------------------------------------------ datasets.json

export type DatasetRegistryEntry = {
  status: string;
  source?: string | null;
  version?: string | null;
  license?: string | null;
  files?: unknown[];
  sha256?: Record<string, string>;
  rows?: number | null;
  blocked_reason?: string | null;
  [key: string]: unknown;
};

export function validateDatasetRegistry(json: unknown): Record<string, DatasetRegistryEntry> {
  const issues = new ManifestIssues('datasets.json');
  issues.require(isObject(json) && isObject(json.datasets), 'must contain a "datasets" object');
  issues.throwIfAny();
  const datasets = (json as Json).datasets as Json;
  for (const [name, entry] of Object.entries(datasets)) {
    if (!isObject(entry)) {
      issues.require(false, `${name} must be an object`);
      continue;
    }
    issues.require(typeof entry.status === 'string', `${name}.status must be a string`);
    issues.require(entry.sha256 === undefined || isObject(entry.sha256), `${name}.sha256 must be an object`);
    issues.require(entry.rows === undefined || entry.rows === null || isCount(entry.rows), `${name}.rows must be a non-negative integer`);
  }
  issues.require(Object.keys(datasets).length > 0, 'contains no datasets');
  issues.throwIfAny();
  return datasets as Record<string, DatasetRegistryEntry>;
}

// ------------------------------------------------------------------ licenses.json

export type LicenseEntry = {
  dataset: string;
  source: string;
  license: string;
  allowed_for_research: boolean;
  redistribution_constraints: string;
  status: string;
  citation?: string;
  notes?: string;
  text_allowed_in_reports?: boolean;
};

export function validateLicenses(json: unknown): LicenseEntry[] {
  const issues = new ManifestIssues('licenses.json');
  issues.require(isObject(json) && Array.isArray(json.datasets), 'must contain a "datasets" array');
  issues.throwIfAny();
  const entries = (json as Json).datasets as unknown[];
  entries.forEach((entry, index) => {
    if (!isObject(entry)) {
      issues.require(false, `datasets[${index}] must be an object`);
      return;
    }
    for (const key of ['dataset', 'source', 'license', 'redistribution_constraints', 'status']) {
      issues.require(typeof entry[key] === 'string' && (entry[key] as string).length > 0, `datasets[${index}].${key} is required`);
    }
    issues.require(typeof entry.allowed_for_research === 'boolean', `datasets[${index}].allowed_for_research must be boolean`);
  });
  issues.throwIfAny();
  return entries as LicenseEntry[];
}

// ------------------------------------------------------------------ dataset_statistics.json

export type DatasetStatistics = {
  datasetVersion: string;
  gitCommit?: string;
  rows_original: number;
  rows_valid: number;
  kept_rows: number;
  human: number;
  machine: number;
  mixed: number;
  spanish: number;
  academic: number;
  exact_duplicates_removed: number;
  near_duplicates_removed: number;
  label_conflicts: number;
  splits: Record<string, number>;
  by_language: Record<string, unknown>;
  by_domain: Record<string, unknown>;
  by_generator: Record<string, unknown>;
  by_generator_family: Record<string, unknown>;
  by_attack: Record<string, unknown>;
  by_dataset: Record<string, Json>;
  leakage: { result: string; [key: string]: unknown };
  [key: string]: unknown;
};

export function validateStatistics(json: unknown): DatasetStatistics {
  const issues = new ManifestIssues('dataset_statistics.json');
  if (!issues.require(isObject(json), 'must be an object')) issues.throwIfAny();
  const stats = json as Json;
  issues.require(typeof stats.datasetVersion === 'string', 'datasetVersion is required');
  for (const key of ['rows_original', 'rows_valid', 'kept_rows', 'human', 'machine', 'mixed', 'spanish', 'academic',
    'exact_duplicates_removed', 'near_duplicates_removed', 'label_conflicts']) {
    issues.require(isCount(stats[key]), `${key} must be a non-negative integer`);
  }
  for (const key of ['splits', 'by_language', 'by_domain', 'by_generator', 'by_generator_family', 'by_attack', 'by_dataset']) {
    issues.require(isObject(stats[key]), `${key} must be an object`);
  }
  issues.require(isObject(stats.leakage) && typeof (stats.leakage as Json).result === 'string', 'leakage.result is required');
  if (isObject(stats.splits)) {
    for (const [split, count] of Object.entries(stats.splits)) {
      issues.require(isCount(count), `splits.${split} must be a non-negative integer`);
    }
  }
  issues.throwIfAny();
  return stats as DatasetStatistics;
}

// ------------------------------------------------------------------ split / master manifests

export type SplitManifest = {
  datasetVersion: string;
  rule: string;
  file: string;
  sha256: string;
  rows: number;
  split_counts: Record<string, number>;
  status_counts?: Record<string, number>;
};

export function validateSplitManifest(json: unknown): SplitManifest {
  const issues = new ManifestIssues('split_manifest.json');
  if (!issues.require(isObject(json), 'must be an object')) issues.throwIfAny();
  const m = json as Json;
  issues.require(typeof m.datasetVersion === 'string', 'datasetVersion is required');
  issues.require(typeof m.sha256 === 'string' && /^[0-9a-f]{64}$/.test(m.sha256), 'sha256 must be a hex SHA-256');
  issues.require(isCount(m.rows), 'rows must be a non-negative integer');
  issues.require(isObject(m.split_counts), 'split_counts must be an object');
  if (isObject(m.split_counts)) {
    for (const [split, count] of Object.entries(m.split_counts)) {
      issues.require(split in SPLIT_NAMES, `unknown split "${split}"`);
      issues.require(isCount(count), `split_counts.${split} must be a non-negative integer`);
    }
  }
  issues.throwIfAny();
  return m as unknown as SplitManifest;
}

export type MasterManifest = {
  datasetVersion: string;
  gitCommit?: string;
  configSha256?: string;
  shards: Record<string, { sha256: string; bytes: number; rows: number }>;
  [key: string]: unknown;
};

export function validateMasterManifest(json: unknown): MasterManifest {
  const issues = new ManifestIssues('master_manifest.json');
  if (!issues.require(isObject(json), 'must be an object')) issues.throwIfAny();
  const m = json as Json;
  issues.require(typeof m.datasetVersion === 'string', 'datasetVersion is required');
  issues.require(isObject(m.shards), 'shards must be an object');
  if (isObject(m.shards)) {
    for (const [path, shard] of Object.entries(m.shards)) {
      issues.require(!path.includes('..'), `shard path ${path} must not contain ".."`);
      issues.require(
        isObject(shard) && typeof shard.sha256 === 'string' && /^[0-9a-f]{64}$/.test(shard.sha256 as string)
          && isCount(shard.bytes) && isCount(shard.rows),
        `shard ${path} needs sha256, bytes and rows`,
      );
    }
  }
  issues.throwIfAny();
  return m as unknown as MasterManifest;
}

export const SPLIT_NAMES: Record<string, DatasetSplit> = {
  train: DatasetSplit.TRAIN,
  validation: DatasetSplit.VALIDATION,
  test: DatasetSplit.TEST,
  ood_test: DatasetSplit.OOD,
  adversarial_test: DatasetSplit.ADVERSARIAL_TEST,
  adversarial_validation: DatasetSplit.ADVERSARIAL_VALIDATION,
  unseen_generator_test: DatasetSplit.UNSEEN_GENERATOR_TEST,
  unseen_domain_test: DatasetSplit.UNSEEN_DOMAIN_TEST,
  mixed: DatasetSplit.MIXED,
};

// ------------------------------------------------------------------ model_registry.json

export type ModelRegistryEntry = {
  name: string;
  architecture: string;
  variant?: string;
  modelType: ModelType;
  status: ModelStatus;
  trainingEnvironment?: string;
  commercialEligibility: CommercialEligibility;
  gitCommit?: string;
  artifact?: { provider: StorageProvider; path: string; external?: boolean; sizeBytes?: number; note?: string };
  metrics: Json;
  thresholds?: Record<string, number | null>;
  calibration?: Json;
  limitations?: string[];
  metadata?: Json;
};

/** Statuses a registry/import may set. ACTIVE is a production decision outside F004. */
export const IMPORTABLE_MODEL_STATUSES: ModelStatus[] = [
  ModelStatus.EXPERIMENTAL, ModelStatus.CANDIDATE, ModelStatus.RETIRED, ModelStatus.INVALID,
];

export function validateModelRegistry(json: unknown): { datasetVersion: string; models: ModelRegistryEntry[] } {
  const issues = new ManifestIssues('model_registry.json');
  if (!issues.require(isObject(json), 'must be an object')) issues.throwIfAny();
  const m = json as Json;
  issues.require(m.modelRegistrySchemaVersion === MODEL_REGISTRY_SCHEMA_VERSION,
    `modelRegistrySchemaVersion must be ${MODEL_REGISTRY_SCHEMA_VERSION}`);
  issues.require(typeof m.datasetVersion === 'string', 'datasetVersion is required');
  issues.require(Array.isArray(m.models) && m.models.length > 0, 'models must be a non-empty array');
  issues.throwIfAny();
  (m.models as unknown[]).forEach((entry, i) => {
    if (!isObject(entry)) {
      issues.require(false, `models[${i}] must be an object`);
      return;
    }
    validateModelEntry(entry, `models[${i}]`, issues);
  });
  issues.throwIfAny();
  return { datasetVersion: m.datasetVersion as string, models: m.models as ModelRegistryEntry[] };
}

export function validateModelEntry(entry: Json, prefix: string, issues: ManifestIssues): void {
  issues.require(typeof entry.name === 'string' && /^[A-Z0-9_]{3,80}$/.test(entry.name), `${prefix}.name must be UPPER_SNAKE_CASE`);
  issues.require(typeof entry.architecture === 'string' && entry.architecture.length > 0, `${prefix}.architecture is required`);
  issues.require(Object.values(ModelType).includes(entry.modelType as ModelType), `${prefix}.modelType is invalid`);
  issues.require(Object.values(ModelStatus).includes(entry.status as ModelStatus), `${prefix}.status is invalid`);
  issues.require(entry.status !== ModelStatus.ACTIVE, `${prefix}.status ACTIVE cannot be set by registration (production activation is a later phase)`);
  issues.require(Object.values(CommercialEligibility).includes(entry.commercialEligibility as CommercialEligibility),
    `${prefix}.commercialEligibility is invalid`);
  issues.require(isObject(entry.metrics), `${prefix}.metrics must be an object`);
  if (entry.artifact !== undefined) {
    const a = entry.artifact;
    issues.require(isObject(a) && Object.values(StorageProvider).includes(a.provider as StorageProvider)
      && typeof a.path === 'string' && a.path.length > 0, `${prefix}.artifact needs provider and path`);
    if (isObject(a) && typeof a.path === 'string') {
      issues.require(!/^[a-z]+:\/\//i.test(a.path) && !/[?&](sig|token|key|X-Goog)/i.test(a.path),
        `${prefix}.artifact.path must be a logical path, not a URL or signed link`);
    }
  }
  if (entry.thresholds !== undefined) {
    issues.require(isObject(entry.thresholds) && Object.values(entry.thresholds).every(
      (v) => v === null || (typeof v === 'number' && v >= 0 && v <= 1)), `${prefix}.thresholds must be numbers in [0, 1]`);
  }
  issues.require(entry.limitations === undefined || (Array.isArray(entry.limitations)
    && entry.limitations.every((l) => typeof l === 'string')), `${prefix}.limitations must be strings`);
}

// ------------------------------------------------------------------ classification

export function classifyLicense(license: string | null | undefined, status?: string): {
  licenseStatus: LicenseStatus;
  commercialUseStatus: CommercialUseStatus;
} {
  if (status === 'BLOCKED_ACCESS') {
    return { licenseStatus: LicenseStatus.BLOCKED, commercialUseStatus: CommercialUseStatus.UNCLEAR };
  }
  if (status === 'EXCLUDED_LICENSE') {
    return { licenseStatus: LicenseStatus.RESTRICTED, commercialUseStatus: CommercialUseStatus.NOT_ALLOWED };
  }
  const text = (license ?? '').toUpperCase();
  if (!text.trim()) {
    return { licenseStatus: LicenseStatus.UNKNOWN, commercialUseStatus: CommercialUseStatus.UNCLEAR };
  }
  if (/\bNC\b|NON-?COMMERCIAL/.test(text.replace(/-/g, ' ').replace(/\s+/g, ' ')) || /-NC-|-NC$/.test(text)) {
    return { licenseStatus: LicenseStatus.NON_COMMERCIAL_ONLY, commercialUseStatus: CommercialUseStatus.NOT_ALLOWED };
  }
  if (/NOT DECLARED|UNDECLARED|UNSPECIFIED/.test(text)) {
    return { licenseStatus: LicenseStatus.UNDECLARED, commercialUseStatus: CommercialUseStatus.UNCLEAR };
  }
  if (/^(MIT|APACHE-2\.0|CC-BY-[0-9.]+|CC-BY-SA-[0-9.]+)\b/.test(text)) {
    return { licenseStatus: LicenseStatus.ALLOWED, commercialUseStatus: CommercialUseStatus.ALLOWED };
  }
  return { licenseStatus: LicenseStatus.UNKNOWN, commercialUseStatus: CommercialUseStatus.UNCLEAR };
}

export function sourceStatus(status: string | undefined): DatasetSourceStatus {
  switch (status) {
    case 'BLOCKED_ACCESS':
      return DatasetSourceStatus.BLOCKED_ACCESS;
    case 'EXCLUDED_LICENSE':
      return DatasetSourceStatus.EXCLUDED_LICENSE;
    case 'INCLUDED':
    case 'DOWNLOADED':
      return DatasetSourceStatus.INCLUDED;
    default:
      return DatasetSourceStatus.CONSIDERED;
  }
}

export function sourceType(url: string | null | undefined): DatasetSourceType {
  const value = (url ?? '').toLowerCase();
  if (value.includes('huggingface.co')) return DatasetSourceType.HUGGINGFACE;
  if (value.includes('zenodo.org')) return DatasetSourceType.ZENODO;
  if (value.includes('github.com')) return DatasetSourceType.GITHUB;
  return DatasetSourceType.OTHER;
}
