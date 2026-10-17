import { z } from 'zod'
import { getJson, postJson } from './client'

const nullableNumber = z.number().nullable()
const nullableString = z.string().nullable()
const classification = z.enum(['MACHINE_SIGNAL', 'LOW_SIGNAL', 'INSUFFICIENT_TEXT'])

export const ANALYZERS = ['V3_ONLY', 'V2_ONLY', 'ENSEMBLE'] as const
export const THRESHOLD_PROFILES = ['BALANCED', 'LOW_FALSE_POSITIVE', 'VERY_LOW_FALSE_POSITIVE'] as const
export const PARAGRAPH_MODES = ['CONTEXTUAL_PARAGRAPH', 'STRICT_PARAGRAPH'] as const
export type AnalyzerName = (typeof ANALYZERS)[number]
export type ThresholdProfileName = (typeof THRESHOLD_PROFILES)[number]
export type ParagraphModeName = (typeof PARAGRAPH_MODES)[number]

export const modelResultSchema = z.object({
  modelName: z.string(),
  modelVariant: nullableString,
  calibratedScore: nullableNumber,
  threshold: nullableNumber,
  thresholdProfile: z.string(),
  classification: classification.nullable(),
  calibration: nullableString,
  preprocessing: nullableString,
  inferenceMs: nullableNumber,
}).passthrough()

export const analysisRunSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid().optional(),
  status: z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED']),
  analyzerMode: z.enum(ANALYZERS),
  analyzerVersion: z.string(),
  thresholdProfile: z.string(),
  threshold: nullableNumber,
  paragraphMode: nullableString,
  documentAggregation: nullableString,
  documentScore: nullableNumber,
  documentClassification: classification.nullable(),
  signalLevel: nullableString,
  scoredSegments: z.number(),
  insufficientSegments: z.number(),
  inferenceMs: nullableNumber,
  errorCode: nullableString,
  createdAt: z.string(),
  completedAt: nullableString,
  modelResults: z.array(modelResultSchema).optional(),
  disclaimer: z.string().optional(),
}).passthrough()

export const analysisListSchema = z.object({ items: z.array(analysisRunSchema) })

export const segmentSchema = z.object({
  paragraphIndex: z.number(),
  charStart: z.number(),
  charEnd: z.number(),
  pageNumber: nullableNumber,
  words: nullableNumber,
  calibratedScore: nullableNumber,
  classification,
  signalLevel: nullableString,
  confidence: nullableString,
  text: nullableString,
}).passthrough()

export const segmentListSchema = z.object({
  analysisId: z.string().uuid(),
  stale: z.boolean(),
  items: z.array(segmentSchema),
})

export const comparisonParagraphSchema = z.object({
  status: z.enum(['UNCHANGED', 'MODIFIED', 'ADDED', 'REMOVED']),
  baseParagraphIndex: nullableNumber,
  targetParagraphIndex: nullableNumber,
  similarity: z.number(),
  baseScore: nullableNumber,
  targetScore: nullableNumber,
  delta: nullableNumber,
}).passthrough()

const driftSchema = z.object({ n: z.number(), mean: z.number(), median: z.number(), p90: z.number(), p95: z.number(),
  max: z.number() }).nullable()

export const comparisonSchema = z.object({
  id: z.string().uuid(),
  documentSimilarity: nullableNumber,
  globalScoreDelta: nullableNumber,
  changedSegments: z.number(),
  unchangedSegments: z.number(),
  addedSegments: z.number(),
  removedSegments: z.number(),
  details: z.object({
    paragraphs: z.array(comparisonParagraphSchema),
    unchangedDrift: driftSchema,
    baseDocumentScore: nullableNumber,
    targetDocumentScore: nullableNumber,
  }).passthrough(),
  disclaimer: z.string(),
}).passthrough()

export const analyzerModelSchema = z.object({
  name: z.string(),
  id: nullableString,
  registeredInDatabase: z.boolean(),
  status: nullableString,
  architecture: nullableString,
  variant: nullableString,
  dataset: nullableString,
  availability: z.string(),
  artifactPresent: z.boolean(),
  servable: z.boolean(),
  thresholdProfiles: z.array(z.string()),
  thresholdSource: nullableString,
  preprocessing: z.array(z.string()),
  warnings: z.array(z.string()),
}).passthrough()

export const analyzerModelListSchema = z.object({
  aiServiceReachable: z.boolean(),
  items: z.array(analyzerModelSchema),
})

export type AnalysisRun = z.infer<typeof analysisRunSchema>
export type AnalysisSegment = z.infer<typeof segmentSchema>
export type AnalysisComparison = z.infer<typeof comparisonSchema>
export type AnalyzerModel = z.infer<typeof analyzerModelSchema>

export const analysisQueryKeys = {
  models: () => ['analysis', 'models'] as const,
  documentAnalyses: (documentId: string) => ['analysis', 'document', documentId] as const,
  run: (id: string) => ['analysis', 'run', id] as const,
  segments: (id: string) => ['analysis', 'segments', id] as const,
}

export function listAnalyzerModels() {
  return getJson('/models', analyzerModelListSchema)
}

export function listDocumentAnalyses(documentId: string) {
  return getJson(`/documents/${documentId}/analyses`, analysisListSchema)
}

export function analyzeDocument(documentId: string, body: {
  analyzer: AnalyzerName
  thresholdProfile: ThresholdProfileName
  paragraphMode: ParagraphModeName
}) {
  return postJson(`/documents/${documentId}/analyze`, analysisRunSchema, { ...body, granularity: 'PARAGRAPH' })
}

export function getAnalysisSegments(analysisId: string) {
  return getJson(`/analyses/${analysisId}/segments`, segmentListSchema)
}

export function compareAnalyses(baseAnalysisId: string, targetAnalysisId: string) {
  return postJson('/analyses/compare', comparisonSchema, { baseAnalysisId, targetAnalysisId })
}
