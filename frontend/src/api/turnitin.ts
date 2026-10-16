import { z } from 'zod'
import { deleteResource, getJson, postFile, postJson } from './client'

export const turnitinReportTypeSchema = z.enum(['AI_WRITING', 'SIMILARITY', 'UNKNOWN'])
export const turnitinReportStatusSchema = z.enum([
  'UPLOADED', 'PROCESSING', 'PARSED', 'PARTIAL', 'FAILED', 'OCR_REQUIRED',
])
export const turnitinSegmentTypeSchema = z.enum([
  'AI_FLAGGED', 'SIMILARITY_MATCH', 'NOT_FLAGGED', 'UNKNOWN',
])

const nullableString = z.string().nullable()
const nullableNumber = z.number().nullable()

const scoreSchema = z.object({ raw: nullableString, percentage: nullableNumber }).passthrough()

export const turnitinReportSchema = z.object({
  id: z.string().uuid(),
  originalName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  reportType: turnitinReportTypeSchema,
  status: turnitinReportStatusSchema,
  parserVersion: nullableString,
  submissionId: nullableString,
  submissionFileName: nullableString,
  submittedAt: z.string().nullable(),
  downloadedAt: z.string().nullable(),
  requiresOcr: z.boolean(),
  reportPageCount: z.number().int().nullable(),
  documentPageCount: z.number().int().nullable(),
  wordCount: z.number().int().nullable(),
  characterCount: z.number().int().nullable(),
  scores: z.object({
    aiWriting: scoreSchema,
    similarity: scoreSchema,
    internet: scoreSchema,
    publications: scoreSchema,
    studentPapers: scoreSchema,
  }),
  filters: z.array(z.string()),
  warnings: z.array(z.string()),
  reportMetadata: z.unknown().nullable(),
  documentVersionId: nullableString,
  documentId: nullableString,
  documentName: nullableString,
  contentMatchStatus: z.enum(['UNVERIFIED', 'EXACT', 'HIGH', 'PARTIAL', 'MISMATCH']),
  submissionRelation: z.enum(['UNKNOWN', 'SAME', 'DIFFERENT']),
  contentSimilarityRatio: nullableNumber,
  sourceCount: z.number().int().nonnegative(),
  segmentCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  matchedAt: z.string().nullable(),
  alignmentVersion: nullableString,
  alignmentEngine: nullableString,
  alignmentStale: z.boolean(),
}).passthrough()

export type TurnitinReport = z.infer<typeof turnitinReportSchema>

const listSchema = z.object({
  items: z.array(turnitinReportSchema),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
}).passthrough()

const sourceSchema = z.object({
  id: z.string().uuid(),
  reportId: z.string().uuid(),
  sourceIndex: z.number().int().positive(),
  sourceType: z.enum(['INTERNET', 'PUBLICATION', 'STUDENT_PAPER', 'OTHER']),
  displayName: z.string(),
  percentageRaw: nullableString,
  percentage: nullableNumber,
  percentageIsLessThan: z.boolean(),
  color: nullableString,
}).passthrough()

const segmentSourceSchema = sourceSchema.pick({
  id: true,
  sourceIndex: true,
  sourceType: true,
  displayName: true,
  percentageRaw: true,
}).nullable()

const segmentSchema = z.object({
  id: z.string().uuid(),
  reportId: z.string().uuid(),
  segmentIndex: z.number().int().positive(),
  segmentType: turnitinSegmentTypeSchema,
  pageNumber: z.number().int().positive(),
  text: z.string(),
  normalizedText: nullableString,
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  sourceIndex: z.number().int().nullable(),
  color: nullableString,
  documentStartOffset: z.number().int().nullable(),
  documentEndOffset: z.number().int().nullable(),
  alignmentMethod: nullableString,
  alignmentScore: nullableNumber,
  source: segmentSourceSchema,
}).passthrough()

const pagedSourcesSchema = z.object({
  items: z.array(sourceSchema),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
}).passthrough()

const pagedSegmentsSchema = z.object({
  items: z.array(segmentSchema),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
}).passthrough()

const groundTruthCaseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  caseType: z.enum(['AI_REPORT', 'SIMILARITY_REPORT', 'VALIDATION']),
  aiReportId: nullableString,
  similarityReportId: nullableString,
  documentVersionId: nullableString,
  submissionRelation: z.enum(['UNKNOWN', 'SAME', 'DIFFERENT']),
  contentMatchStatus: z.enum(['UNVERIFIED', 'EXACT', 'HIGH', 'PARTIAL', 'MISMATCH']),
  validationStatus: z.enum(['UNVERIFIED', 'EXACT', 'HIGH', 'PARTIAL', 'MISMATCH']),
  expectedData: z.unknown().nullable(),
  actualData: z.unknown().nullable(),
  notes: nullableString,
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough()

export const turnitinQueryKeys = {
  all: ['turnitin-reports'] as const,
  list: (page: number, limit: number) => ['turnitin-reports', 'list', { page, limit }] as const,
  detail: (id: string) => ['turnitin-reports', 'detail', id] as const,
  sources: (id: string, page: number) => ['turnitin-reports', 'sources', id, page] as const,
  segments: (id: string, page: number, type?: string) => ['turnitin-reports', 'segments', id, page, type] as const,
  groundTruth: ['turnitin-reports', 'ground-truth'] as const,
}

export function listTurnitinReports(page = 1, limit = 20) {
  const query = new URLSearchParams({ page: String(page), limit: String(limit) })
  return getJson(`/turnitin/reports?${query.toString()}`, listSchema)
}

export function getTurnitinReport(id: string) {
  return getJson(`/turnitin/reports/${encodeURIComponent(id)}`, turnitinReportSchema)
}

export function uploadTurnitinReport(file: File) {
  return postFile('/turnitin/reports', file, turnitinReportSchema)
}

export function listTurnitinSources(id: string, page = 1, limit = 100) {
  const query = new URLSearchParams({ page: String(page), limit: String(limit) })
  return getJson(`/turnitin/reports/${encodeURIComponent(id)}/sources?${query.toString()}`, pagedSourcesSchema)
}

export function listTurnitinSegments(id: string, page = 1, limit = 50, segmentType?: string) {
  const query = new URLSearchParams({ page: String(page), limit: String(limit) })
  if (segmentType) query.set('segmentType', segmentType)
  return getJson(`/turnitin/reports/${encodeURIComponent(id)}/segments?${query.toString()}`, pagedSegmentsSchema)
}

export function reparseTurnitinReport(id: string) {
  return postJson(`/turnitin/reports/${encodeURIComponent(id)}/reparse`, turnitinReportSchema)
}

export function ocrReparseTurnitinReport(id: string) {
  return postJson(`/turnitin/reports/${encodeURIComponent(id)}/ocr-reparse`, turnitinReportSchema)
}

export function matchTurnitinReport(id: string, documentVersionId: string) {
  return postJson(`/turnitin/reports/${encodeURIComponent(id)}/match`, turnitinReportSchema, { documentVersionId })
}

export function deleteTurnitinReport(id: string) {
  return deleteResource(`/turnitin/reports/${encodeURIComponent(id)}`)
}

export function listGroundTruthCases(page = 1, limit = 20) {
  const query = new URLSearchParams({ page: String(page), limit: String(limit) })
  return getJson(`/turnitin/ground-truth?${query.toString()}`, z.object({
    items: z.array(groundTruthCaseSchema),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  }).passthrough())
}

export function createGroundTruthCase(input: {
  name: string
  caseType: 'AI_REPORT' | 'SIMILARITY_REPORT' | 'VALIDATION'
  aiReportId?: string
  similarityReportId?: string
  documentVersionId?: string
  expectedData?: Record<string, unknown>
  notes?: string
}) {
  return postJson('/turnitin/ground-truth', groundTruthCaseSchema, input)
}

export function updateGroundTruthCase(id: string, input: { expectedData?: Record<string, unknown>; notes?: string | null }) {
  return postJson(`/turnitin/ground-truth/${encodeURIComponent(id)}`, groundTruthCaseSchema, input)
}
