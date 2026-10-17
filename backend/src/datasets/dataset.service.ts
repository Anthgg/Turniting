import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  DatasetArtifactType,
  DatasetStatus,
  Prisma,
  PrivacyClass,
  StorageProvider,
  type TrainingSample,
} from '@prisma/client';
import { DatasetRepository } from './dataset.repository.js';
import type {
  ImportManifestDto,
  ListTrainingSamplesQueryDto,
  RegisterDatasetDto,
} from './dto/datasets.dto.js';
import {
  DATASET_MANIFEST_SCHEMA_VERSION,
  SPLIT_NAMES,
  classifyLicense,
  isObject,
  sourceStatus,
  sourceType,
  validateDatasetRegistry,
  validateLicenses,
  validateMasterManifest,
  validateSplitManifest,
  validateStatistics,
  type DatasetStatistics,
} from './manifest-schemas.js';
import { TrainingFilesService } from './training-files.service.js';

export const DEFAULT_MANIFEST_DIR = 'datasets/manifests';
export const DEFAULT_STATISTICS_PATH = 'reports/dataset_statistics.json';

/** Reports registered as dataset artifacts when present in TRAINING_DIR. */
const REPORT_ARTIFACTS: Array<[string, DatasetArtifactType]> = [
  ['reports/dataset_statistics.md', DatasetArtifactType.STATISTICS],
  ['reports/TRAINING_REPORT.md', DatasetArtifactType.TRAINING_REPORT],
  ['reports/TRAINING_REPORT.json', DatasetArtifactType.TRAINING_REPORT],
  ['reports/TRAINING_GPU_REPORT.md', DatasetArtifactType.TRAINING_REPORT],
  ['reports/TRAINING_GPU_REPORT.json', DatasetArtifactType.TRAINING_REPORT],
  ['reports/baseline_metrics.json', DatasetArtifactType.EVALUATION_REPORT],
  ['reports/error_analysis.md', DatasetArtifactType.EVALUATION_REPORT],
  ['configs/datasets.yaml', DatasetArtifactType.CONFIG],
  ['configs/build.yaml', DatasetArtifactType.CONFIG],
  ['configs/training.yaml', DatasetArtifactType.CONFIG],
  ['configs/training_gpu.yaml', DatasetArtifactType.CONFIG],
];

type SampleView = Omit<TrainingSample, 'text'> & { text: string | null; textRedacted: boolean };

@Injectable()
export class DatasetService {
  constructor(
    private readonly repository: DatasetRepository,
    private readonly files: TrainingFilesService,
  ) {}

  async list(page: number, limit: number) {
    const { items, total } = await this.repository.listVersions(page, limit);
    return {
      items: items.map(({ sources, ...version }) => ({
        ...version,
        displayName: `${version.name}_${version.version}`,
        licenseWarnings: licenseWarnings(sources),
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getById(id: string) {
    const version = await this.repository.findVersion(id);
    if (!version) throw new NotFoundException('Dataset version not found');
    const sources = await this.repository.listSources(id);
    return {
      ...version,
      displayName: `${version.name}_${version.version}`,
      licenseWarnings: licenseWarnings(sources),
    };
  }

  async getSources(id: string) {
    await this.requireVersion(id);
    return this.repository.listSources(id);
  }

  async getArtifacts(id: string) {
    await this.requireVersion(id);
    const artifacts = await this.repository.listArtifacts(id);
    return artifacts.map((a) => ({ ...a, sizeBytes: a.sizeBytes === null ? null : Number(a.sizeBytes) }));
  }

  async getStatistics(id: string) {
    const version = await this.requireVersion(id);
    const metadata = isObject(version.metadata) ? version.metadata : {};
    return {
      datasetVersionId: version.id,
      displayName: `${version.name}_${version.version}`,
      status: version.status,
      counts: {
        totalRows: version.totalRows,
        humanRows: version.humanRows,
        machineRows: version.machineRows,
        mixedRows: version.mixedRows,
        spanishRows: version.spanishRows,
        academicRows: version.academicRows,
        languageCount: version.languageCount,
        domainCount: version.domainCount,
        generatorCount: version.generatorCount,
      },
      dedup: {
        exactDuplicatesRemoved: version.exactDuplicatesRemoved,
        nearDuplicatesRemoved: version.nearDuplicatesRemoved,
        labelConflicts: version.labelConflicts,
      },
      leakageStatus: version.leakageStatus,
      statistics: metadata.statistics ?? null,
    };
  }

  async listSamples(id: string, query: ListTrainingSamplesQueryDto) {
    await this.requireVersion(id);
    const where: Prisma.TrainingSampleWhereInput = {
      datasetVersionId: id,
      label: query.label,
      labelSource: query.labelSource,
      split: query.split,
      language: query.language,
      eligibleForTraining: query.eligibleForTraining,
    };
    const { items, total } = await this.repository.listSamples(where, query.page, query.limit);
    return {
      items: items.map(redactSample),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async register(body: RegisterDatasetDto) {
    const existing = await this.repository.findVersionByNameVersion(body.name, body.version);
    if (existing) {
      throw new ConflictException(`${body.name}_${body.version} is already registered (id ${existing.id})`);
    }
    const created = await this.repository.createVersion({
      name: body.name,
      version: body.version,
      description: body.description,
      status: DatasetStatus.DRAFT,
      schemaVersion: DATASET_MANIFEST_SCHEMA_VERSION,
    });
    if (body.manifestPath || body.statisticsPath) {
      return this.importManifest(created.id, { manifestPath: body.manifestPath, statisticsPath: body.statisticsPath });
    }
    return created;
  }

  /**
   * Import licences, registry, statistics, master and split manifests from TRAINING_DIR.
   * Only metadata is stored; Parquet shards are referenced as external artifacts.
   */
  async importManifest(id: string, body: ImportManifestDto) {
    const version = await this.requireVersion(id);
    const dir = (body.manifestPath ?? DEFAULT_MANIFEST_DIR).replace(/[\\/]+$/, '');
    const statsPath = body.statisticsPath ?? DEFAULT_STATISTICS_PATH;
    const paths = {
      registry: `${dir}/datasets.json`,
      licenses: `${dir}/licenses.json`,
      master: `${dir}/master_manifest.json`,
      split: `${dir}/split_manifest.json`,
      raid: `${dir}/raid_sampling.json`,
    };

    const licenses = validateLicenses(await this.files.readJson(paths.licenses));
    const registry = validateDatasetRegistry(await this.files.readJson(paths.registry));
    const stats = validateStatistics(await this.files.readJson(statsPath));
    const master = validateMasterManifest(await this.files.readJson(paths.master));
    const split = validateSplitManifest(await this.files.readJson(paths.split));
    const raid = (await this.files.exists(paths.raid)) ? await this.files.readJson(paths.raid) : null;
    const usage = await this.readUsage();

    const expected = `${version.name}_${version.version}`;
    for (const [file, value] of [['dataset_statistics.json', stats.datasetVersion],
      ['master_manifest.json', master.datasetVersion], ['split_manifest.json', split.datasetVersion]] as const) {
      if (value !== expected) {
        throw new BadRequestException(`${file} describes ${value}, not ${expected}`);
      }
    }

    const splitFile = split.file.split(' ')[0];
    const sources = buildSources(id, licenses, registry, stats, usage, raid);
    const splits = Object.entries(split.split_counts).map(([name, rowCount]) => ({
      datasetVersionId: id,
      split: SPLIT_NAMES[name],
      rowCount,
      manifestPath: `training/${splitFile}`,
      sha256: split.sha256,
      metadata: { sourceSplitName: name, rule: split.rule, storage: 'LOCAL', external: true },
    }));

    const artifacts: Prisma.DatasetArtifactCreateManyInput[] = [];
    const repoFiles: Array<[string, DatasetArtifactType]> = [
      [paths.registry, DatasetArtifactType.MANIFEST],
      [paths.master, DatasetArtifactType.MANIFEST],
      [paths.licenses, DatasetArtifactType.LICENSE_AUDIT],
      [paths.split, DatasetArtifactType.SPLIT_MANIFEST],
      [statsPath, DatasetArtifactType.STATISTICS],
      ...REPORT_ARTIFACTS,
    ];
    if (raid) repoFiles.push([paths.raid, DatasetArtifactType.MANIFEST]);
    for (const [file, type] of repoFiles) {
      const print = await this.files.fingerprint(file);
      if (!print) continue;
      artifacts.push({
        datasetVersionId: id, artifactType: type, storageProvider: StorageProvider.REPOSITORY,
        path: `training/${file}`, sha256: print.sha256, sizeBytes: BigInt(print.sizeBytes), external: false,
      });
    }
    // Split manifest parquet + master shards live outside Git: hashes come from the manifests.
    artifacts.push({
      datasetVersionId: id, artifactType: DatasetArtifactType.SPLIT_MANIFEST, storageProvider: StorageProvider.LOCAL,
      path: `training/${splitFile}`, sha256: split.sha256, external: true,
      metadata: { rows: split.rows, hashSource: 'split_manifest.json' },
    });
    for (const [shardPath, shard] of Object.entries(master.shards)) {
      artifacts.push({
        datasetVersionId: id, artifactType: DatasetArtifactType.PARQUET_SHARD, storageProvider: StorageProvider.LOCAL,
        path: `training/datasets/normalized/${shardPath}`, sha256: shard.sha256, sizeBytes: BigInt(shard.bytes),
        external: true, metadata: { rows: shard.rows, hashSource: 'master_manifest.json' },
      });
    }

    const leakageStatus = String(stats.leakage.result);
    const updated = await this.repository.replaceManifestData(id, {
      status: leakageStatus === 'PASS' ? DatasetStatus.READY : DatasetStatus.INVALID,
      schemaVersion: DATASET_MANIFEST_SCHEMA_VERSION,
      createdFromGitCommit: stats.gitCommit ?? master.gitCommit ?? null,
      totalRows: stats.kept_rows,
      humanRows: stats.human,
      machineRows: stats.machine,
      mixedRows: stats.mixed,
      spanishRows: stats.spanish,
      academicRows: stats.academic,
      languageCount: Object.keys(stats.by_language).length,
      domainCount: Object.keys(stats.by_domain).length,
      generatorCount: Object.keys(stats.by_generator_family).length,
      exactDuplicatesRemoved: stats.exact_duplicates_removed,
      nearDuplicatesRemoved: stats.near_duplicates_removed,
      labelConflicts: stats.label_conflicts,
      leakageStatus,
      manifestPath: `training/${dir}`,
      statisticsPath: `training/${statsPath}`,
      metadata: {
        datasetManifestSchemaVersion: DATASET_MANIFEST_SCHEMA_VERSION,
        statistics: summarizeStatistics(stats),
        configSha256: master.configSha256 ?? null,
        importedAt: new Date().toISOString(),
      } as Prisma.InputJsonValue,
    }, sources, splits, artifacts);
    return { ...updated, imported: { sources: sources.length, splits: splits.length, artifacts: artifacts.length } };
  }

  async requireVersion(id: string) {
    const version = await this.repository.findVersion(id);
    if (!version) throw new NotFoundException('Dataset version not found');
    return version;
  }

  private async readUsage(): Promise<Record<string, number>> {
    const file = 'reports/baseline_metrics.json';
    if (!(await this.files.exists(file))) return {};
    const json = await this.files.readJson(file);
    const usage = isObject(json) && Array.isArray(json.usage) ? json.usage : [];
    const out: Record<string, number> = {};
    for (const row of usage) {
      if (isObject(row) && typeof row.dataset === 'string' && typeof row.sampling_mass === 'number') {
        out[row.dataset] = row.sampling_mass;
      }
    }
    return out;
  }
}

function buildSources(
  datasetVersionId: string,
  licenses: ReturnType<typeof validateLicenses>,
  registry: ReturnType<typeof validateDatasetRegistry>,
  stats: DatasetStatistics,
  usage: Record<string, number>,
  raid: unknown,
): Prisma.DatasetSourceCreateManyInput[] {
  const byName = new Map(licenses.map((l) => [l.dataset, l]));
  const names = new Set<string>([...byName.keys(), ...Object.keys(registry)]);
  const rows: Prisma.DatasetSourceCreateManyInput[] = [];
  for (const name of [...names].sort()) {
    // HC3 Chinese shares the HC3 licence entry.
    const lic = byName.get(name) ?? (name.startsWith('hc3') ? byName.get('hc3') : undefined);
    const reg = registry[name];
    const ds = isObject(stats.by_dataset[name]) ? stats.by_dataset[name] : undefined;
    const status = lic?.status ?? (reg?.status === 'BLOCKED_ACCESS' ? 'BLOCKED_ACCESS' : reg?.status);
    const { licenseStatus, commercialUseStatus } = classifyLicense(lic?.license ?? reg?.license, status);
    const shaEntries = reg?.sha256 ? Object.entries(reg.sha256) : [];
    const languages = ds && isObject(ds.languages) ? ds.languages : {};
    const domains = ds && isObject(ds.domains) ? ds.domains : {};
    const raidRows = name === 'raid' && isObject(raid) ? raid : null;
    rows.push({
      datasetVersionId,
      name,
      status: sourceStatus(status),
      sourceUrl: reg?.source ?? extractUrl(lic?.source),
      sourceType: sourceType(reg?.source ?? lic?.source),
      license: lic?.license ?? reg?.license ?? null,
      licenseStatus,
      commercialUseStatus,
      rowsAvailable: raidRows && typeof raidRows.available_rows === 'number'
        ? raidRows.available_rows : numberOrNull(ds?.rows_original),
      rowsUsed: numberOrNull(ds?.kept),
      spanishRows: numberOrNull(languages.es) ?? (ds ? 0 : null),
      academicRows: numberOrNull(domains.academic) ?? (ds ? 0 : null),
      samplingWeight: usage[name] ?? null,
      sha256: shaEntries.length === 1 ? shaEntries[0][1] : null,
      metadata: {
        licenseSource: lic ? 'licenses.json' : 'datasets.json',
        allowedForResearch: lic?.allowed_for_research ?? null,
        redistributionConstraints: lic?.redistribution_constraints ?? null,
        citation: lic?.citation ?? null,
        notes: lic?.notes ?? null,
        blockedReason: reg?.blocked_reason ?? null,
        sourceVersion: reg?.version ?? null,
        files: reg?.files ?? [],
        sha256: reg?.sha256 ?? {},
        rowsValid: numberOrNull(ds?.rows_valid),
        exactDuplicates: numberOrNull(ds?.exact_duplicates),
        nearDuplicates: numberOrNull(ds?.near_duplicates),
        bySplit: ds?.by_split ?? null,
        raidSampling: raidRows ? { coverage: raidRows.coverage, selectedRows: raidRows.selected_rows, strata: raidRows.strata } : null,
      } as Prisma.InputJsonValue,
    });
  }
  return rows;
}

function summarizeStatistics(stats: DatasetStatistics) {
  return {
    rowsOriginal: stats.rows_original,
    rowsValid: stats.rows_valid,
    rowsInvalid: stats.rows_invalid ?? null,
    keptRows: stats.kept_rows,
    holdoutExclusions: stats.holdout_exclusions ?? null,
    groups: stats.groups ?? null,
    largestGroup: stats.largest_group ?? null,
    splits: stats.splits,
    splitsByLabel: stats.splits_by_label ?? null,
    byLanguage: stats.by_language,
    byDomain: stats.by_domain,
    byGeneratorFamily: stats.by_generator_family,
    byAttack: stats.by_attack,
    nearDup: stats.near_dup ?? null,
    leakage: stats.leakage,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function extractUrl(text: string | undefined): string | null {
  const match = text?.match(/https?:\/\/[^\s)]+/);
  return match ? match[0] : null;
}

export function licenseWarnings(sources: Array<{ name: string; status: string; licenseStatus: string; commercialUseStatus: string }>) {
  const nonCommercial = sources.filter((s) => s.licenseStatus === 'NON_COMMERCIAL_ONLY').map((s) => s.name);
  const undeclared = sources.filter((s) => s.licenseStatus === 'UNDECLARED' || s.licenseStatus === 'UNKNOWN').map((s) => s.name);
  const blocked = sources.filter((s) => s.status === 'BLOCKED_ACCESS' || s.licenseStatus === 'BLOCKED').map((s) => s.name);
  return {
    hasNonCommercialSources: nonCommercial.length > 0,
    nonCommercial,
    undeclared,
    blocked,
    message: nonCommercial.length
      ? 'Este dataset/modelo incluye fuentes con restricciones no comerciales.'
      : null,
  };
}

/** Private samples never expose their text through the API. */
export function redactSample(sample: TrainingSample): SampleView {
  const redacted = sample.privacyClass === PrivacyClass.PRIVATE;
  return { ...sample, text: redacted ? null : sample.text, textRedacted: redacted };
}
