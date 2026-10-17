import { z } from 'zod'
import { getJson } from './client'

const nullableNumber = z.number().nullable()
const nullableString = z.string().nullable()

export const licenseWarningsSchema = z.object({
  hasNonCommercialSources: z.boolean(),
  nonCommercial: z.array(z.string()),
  undeclared: z.array(z.string()),
  blocked: z.array(z.string()),
  message: nullableString,
})

const countsShape = {
  totalRows: nullableNumber,
  humanRows: nullableNumber,
  machineRows: nullableNumber,
  mixedRows: nullableNumber,
  spanishRows: nullableNumber,
  academicRows: nullableNumber,
  languageCount: nullableNumber,
  domainCount: nullableNumber,
  generatorCount: nullableNumber,
}

export const datasetVersionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  version: z.string(),
  displayName: z.string(),
  status: z.enum(['DRAFT', 'BUILDING', 'READY', 'INVALID', 'ARCHIVED']),
  description: nullableString,
  ...countsShape,
  exactDuplicatesRemoved: nullableNumber,
  nearDuplicatesRemoved: nullableNumber,
  labelConflicts: nullableNumber,
  leakageStatus: nullableString,
  manifestPath: nullableString,
  statisticsPath: nullableString,
  createdFromGitCommit: nullableString,
  createdAt: z.string(),
  licenseWarnings: licenseWarningsSchema,
  _count: z.object({ sources: z.number(), samples: z.number() }).passthrough(),
}).passthrough()

export const datasetListSchema = z.object({
  items: z.array(datasetVersionSchema),
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
})

export const splitManifestSchema = z.object({
  split: z.string(),
  rowCount: z.number(),
  groupCount: nullableNumber,
  manifestPath: nullableString,
  sha256: nullableString,
}).passthrough()

export const modelVersionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  architecture: z.string(),
  variant: nullableString,
  status: z.enum(['EXPERIMENTAL', 'CANDIDATE', 'ACTIVE', 'RETIRED', 'INVALID']),
  modelType: z.string(),
  commercialEligibility: z.string(),
  trainingEnvironment: nullableString,
  artifactProvider: nullableString,
  artifactPath: nullableString,
  metrics: z.record(z.string(), z.unknown()),
  thresholds: z.record(z.string(), z.number().nullable()).nullable(),
  limitations: z.array(z.string()),
}).passthrough()

export const datasetDetailSchema = datasetVersionSchema.extend({
  splitManifests: z.array(splitManifestSchema),
  modelVersions: z.array(modelVersionSchema),
})

export const datasetSourceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: z.string(),
  sourceUrl: nullableString,
  sourceType: z.string(),
  license: nullableString,
  licenseStatus: z.string(),
  commercialUseStatus: z.string(),
  rowsAvailable: nullableNumber,
  rowsUsed: nullableNumber,
  spanishRows: nullableNumber,
  academicRows: nullableNumber,
  samplingWeight: nullableNumber,
}).passthrough()

export const datasetArtifactSchema = z.object({
  id: z.string().uuid(),
  artifactType: z.string(),
  storageProvider: z.string(),
  path: z.string(),
  sha256: nullableString,
  sizeBytes: nullableNumber,
  external: z.boolean(),
  modelVersionId: nullableString,
}).passthrough()

export const datasetStatisticsSchema = z.object({
  counts: z.object(countsShape),
  dedup: z.object({ exactDuplicatesRemoved: nullableNumber, nearDuplicatesRemoved: nullableNumber, labelConflicts: nullableNumber }),
  leakageStatus: nullableString,
  statistics: z.object({
    leakage: z.record(z.string(), z.unknown()).optional(),
    byLanguage: z.record(z.string(), z.object({ human: z.number(), machine: z.number() })).optional(),
    byDomain: z.record(z.string(), z.object({ human: z.number(), machine: z.number() })).optional(),
    groups: z.number().nullable().optional(),
  }).passthrough().nullable(),
}).passthrough()

export const trainingSampleListSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    label: z.string(),
    labelSource: z.string(),
    split: nullableString,
    language: nullableString,
    eligibleForTraining: z.boolean(),
    privacyClass: z.string(),
    text: nullableString,
    textRedacted: z.boolean(),
    createdAt: z.string(),
  }).passthrough()),
  total: z.number(),
  page: z.number(),
  totalPages: z.number(),
})

export type DatasetVersion = z.infer<typeof datasetVersionSchema>
export type DatasetDetail = z.infer<typeof datasetDetailSchema>
export type DatasetSource = z.infer<typeof datasetSourceSchema>
export type ModelVersion = z.infer<typeof modelVersionSchema>

export const datasetQueryKeys = {
  all: ['datasets'] as const,
  list: () => ['datasets', 'list'] as const,
  detail: (id: string) => ['datasets', id] as const,
  part: (id: string, part: string, extra?: string) => ['datasets', id, part, extra ?? ''] as const,
}

export function listDatasets() {
  return getJson('/datasets?page=1&limit=50', datasetListSchema)
}

export function getDataset(id: string) {
  return getJson(`/datasets/${id}`, datasetDetailSchema)
}

export function getDatasetSources(id: string) {
  return getJson(`/datasets/${id}/sources`, z.array(datasetSourceSchema))
}

export function getDatasetArtifacts(id: string) {
  return getJson(`/datasets/${id}/artifacts`, z.array(datasetArtifactSchema))
}

export function getDatasetStatistics(id: string) {
  return getJson(`/datasets/${id}/statistics`, datasetStatisticsSchema)
}

export function getDatasetSamples(id: string, filters: Record<string, string>) {
  const params = new URLSearchParams({ page: '1', limit: '20', ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) })
  return getJson(`/datasets/${id}/samples?${params.toString()}`, trainingSampleListSchema)
}
