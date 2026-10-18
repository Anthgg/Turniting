import { z } from 'zod'
import { getJson, postJson } from './client'

const nullableNumber = z.number().nullable()
const nullableString = z.string().nullable()
const classification = z.enum(['MACHINE_SIGNAL', 'LOW_SIGNAL', 'INSUFFICIENT_TEXT'])

export const ANALYZERS = ['V3_ONLY', 'V2_ONLY', 'ENSEMBLE'] as const
export const THRESHOLD_PROFILES = ['BALANCED', 'LOW_FALSE_POSITIVE', 'VERY_LOW_FALSE_POSITIVE'] as const
export const PARAGRAPH_MODES = ['STRICT_PARAGRAPH', 'CONTEXTUAL_PARAGRAPH'] as const
export const ANALYSIS_SEGMENT_SORTS = ['PARAGRAPH', 'SCORE_DESC'] as const
export const ANALYSIS_SEGMENT_FILTERS = ['ALL', 'LOW', 'MODERATE', 'HIGH', 'INSUFFICIENT'] as const
export type AnalyzerName = (typeof ANALYZERS)[number]
export type ThresholdProfileName = (typeof THRESHOLD_PROFILES)[number]
export type ParagraphModeName = (typeof PARAGRAPH_MODES)[number]
export type AnalysisSegmentSort = (typeof ANALYSIS_SEGMENT_SORTS)[number]
export type AnalysisSegmentFilter = (typeof ANALYSIS_SEGMENT_FILTERS)[number]

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
  documentScorePercent: z.number().int().nullable().optional(),
  documentClassification: classification.nullable(),
  signalLevel: nullableString,
  scoredSegments: z.number(),
  insufficientSegments: z.number(),
  inferenceMs: nullableNumber,
  errorCode: nullableString,
  createdAt: z.string(),
  completedAt: nullableString,
  modelResults: z.array(modelResultSchema).optional(),
  metadata: z.unknown().nullable().optional(),
  disclaimer: z.string().optional(),
}).passthrough()

export const analysisListSchema = z.object({ items: z.array(analysisRunSchema) })

export const reviewPresentationSchema = z.object({
  highlight: z.boolean(),
  level: z.enum(['HIGH', 'MODERATE', 'LOW']).nullable(),
  excludedReason: z.enum([
    'REFERENCE_SECTION',
    'METADATA',
    'CAPTION',
    'HEADING',
    'INSUFFICIENT_TEXT',
    'LOW_SIGNAL',
    'UNSCORED',
  ]).optional(),
})

export const segmentSchema = z.object({
  id: z.string().uuid().optional(),
  paragraphIndex: z.number(),
  charStart: z.number(),
  charEnd: z.number(),
  pageNumber: nullableNumber,
  words: nullableNumber,
  tokens: nullableNumber,
  modelName: z.string(),
  rawScore: nullableNumber,
  calibratedScore: nullableNumber,
  classification,
  signalLevel: nullableString,
  confidence: nullableString,
  text: nullableString,
  reviewPresentation: reviewPresentationSchema.optional(),
  contextTokensBefore: z.record(z.string(), z.number()).nullable().optional(),
  contextTokensAfter: z.record(z.string(), z.number()).nullable().optional(),
}).passthrough()

const contextNeighborSchema = z.object({
  paragraphIndex: nullableNumber,
  text: nullableString,
  tokensUsed: z.record(z.string(), z.number()).nullable(),
})

export const analysisSegmentContextSchema = z.object({
  analysisId: z.string().uuid(),
  paragraphMode: z.literal('CONTEXTUAL_PARAGRAPH'),
  contextMetadata: z.object({
    tokenLimitPerSide: nullableNumber,
    measurement: nullableString,
    preprocessingProfiles: z.array(z.string()),
  }),
  target: z.object({
    paragraphIndex: z.number(),
    charStart: z.number(),
    charEnd: z.number(),
    text: z.string(),
  }),
  before: contextNeighborSchema,
  after: contextNeighborSchema,
})

export const segmentListSchema = z.object({
  analysisId: z.string().uuid(),
  stale: z.boolean(),
  documentText: z.string().optional(),
  items: z.array(segmentSchema),
  page: z.number().optional(),
  pageSize: z.number().optional(),
  total: z.number().optional(),
  pages: z.number().optional(),
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

const modelHoldoutMetricsSchema = z.object({
  evaluationSet: z.string(),
  operatingPoint: z.string(),
  macroF1: z.number(),
  overallHumanFpr: z.number(),
  overallHumanFprCi95: z.tuple([z.number(), z.number()]).optional(),
  spanishF1: z.number().optional(),
  spanishHumanFpr: z.number(),
  spanishHumanFprCi95: z.tuple([z.number(), z.number()]).optional(),
  spanishRecall: z.number().optional(),
  spanishEce: z.number().optional(),
  academicHumanFpr: z.number(),
  academicF1: z.number().optional(),
  unseenGeneratorHumanFpr: z.number(),
  oodHumanFpr: z.number(),
  unseenDomainHumanFpr: z.number(),
  unseenDomainF1: z.number().optional(),
  mixedRecall: z.number(),
  aiEditedF1: z.number(),
  oodF1: z.number(),
  unseenGeneratorF1: z.number(),
  adversarialRecall: z.number(),
  zeroWidthF1: z.number(),
  homoglyphF1: z.number(),
  spanTokenF1: nullableNumber.optional(),
}).passthrough()

const researchModelMetadataSchema = z.object({
  sourceBranch: z.string(),
  sourceCommit: z.string(),
  trainingCommit: z.string(),
  trainingPhase: z.string(),
  parentModel: z.string(),
  sourceTrainingParent: z.string(),
  datasetName: z.string(),
  datasetManifestHashes: z.record(z.string(), z.string()),
  datasetVersionId: nullableString,
  artifactAvailableLocally: z.boolean(),
  modelSha256: z.string(),
  artifactChecksumValidated: z.boolean(),
  validationMetrics: z.object({
    evaluationSet: z.string(),
    calibrationOption: z.string(),
    selectedCheckpointStep: z.number(),
    macroF1: z.number(),
    overallHumanFpr: z.number(),
    spanishMacroF1: z.number(),
    spanishHumanFpr: z.number(),
    spanishEce: z.number(),
    selectionCheckpoint: z.object({
      threshold: z.number(),
      overallHumanFpr: z.number(),
      spanishHumanFpr: z.number(),
      academicHumanFpr: z.number(),
      unseenGeneratorHumanFpr: z.number(),
    }).passthrough(),
  }).passthrough(),
  calibration: z.object({
    global: z.string(),
    spanish: z.string(),
    method: z.string(),
    globalThreshold: z.number(),
    spanishThreshold: z.number(),
    spanishEce: z.number(),
  }).passthrough(),
  gatesPassed: z.number(),
  gatesTotal: z.number(),
  failedGates: z.array(z.string()),
  paragraphStability: z.literal('NOT_EVALUATED'),
  strictSupported: z.string(),
  contextualSupported: z.string(),
  languageSelection: z.string(),
  active: z.boolean(),
  candidate: z.boolean(),
  limitations: z.array(z.string()),
}).passthrough()

const numericGateResultSchema = z.object({
  observed: z.number(),
  limit: z.number(),
  passed: z.boolean(),
})

export const analyzerModelSchema = z.object({
  name: z.string(),
  id: nullableString,
  registeredInDatabase: z.boolean(),
  registeredInRegistry: z.boolean().optional(),
  status: nullableString,
  architecture: nullableString,
  variant: nullableString,
  dataset: nullableString,
  availability: z.string(),
  available: z.boolean().optional(),
  active: z.boolean().optional(),
  candidate: z.boolean().optional(),
  artifactPresent: z.boolean(),
  artifactValid: z.boolean().optional(),
  missing: z.array(z.string()).optional(),
  servable: z.boolean(),
  thresholdProfiles: z.array(z.string()),
  thresholdSource: nullableString,
  preprocessing: z.array(z.string()),
  warnings: z.array(z.string()),
  metrics: modelHoldoutMetricsSchema.nullable().optional(),
  strengths: z.array(z.string()).optional(),
  activeGateResults: z.object({
    overallHumanFpr: numericGateResultSchema,
    spanishHumanFpr: numericGateResultSchema,
    academicHumanFpr: numericGateResultSchema,
    unseenGeneratorHumanFpr: numericGateResultSchema,
  }).nullable().optional(),
  officialGateResults: z.record(z.string(), z.boolean()).nullable().optional(),
  promotionEvidence: z.object({
    mixedAiEdited: z.boolean().nullable(),
    robustness: z.boolean().nullable(),
    paragraphStability: z.boolean().nullable(),
    noLeakage: z.boolean().nullable(),
    holdoutNeverTuned: z.boolean().nullable(),
  }).optional(),
  researchMetadata: researchModelMetadataSchema.optional(),
  promotionEligible: z.boolean().optional(),
  promotionReviewRequired: z.boolean().optional(),
}).passthrough()

export const analyzerModelListSchema = z.object({
  aiServiceReachable: z.boolean(),
  activeModel: z.string().optional(),
  recommendedExperimentalAnalyzer: z.string().optional(),
  recommendedExperimentalThresholdProfile: z.string().optional(),
  lowFprAlternative: z.string().optional(),
  lowFprAlternativeThresholdProfile: z.string().optional(),
  promotionReviewRequired: z.boolean().optional(),
  activeAcceptanceLimits: z.object({
    overallHumanFpr: z.number(),
    spanishHumanFpr: z.number(),
    academicHumanFpr: z.number(),
    unseenGeneratorHumanFpr: z.number(),
  }).optional(),
  items: z.array(analyzerModelSchema),
}).passthrough()

export type AnalysisRun = z.infer<typeof analysisRunSchema>
export type AnalysisSegment = z.infer<typeof segmentSchema>
export type AnalysisComparison = z.infer<typeof comparisonSchema>
export type AnalyzerModel = z.infer<typeof analyzerModelSchema>

export type AnalysisSegmentsQuery = {
  page: number
  pageSize: number
  sort: AnalysisSegmentSort
  filter: AnalysisSegmentFilter
}

export const analysisQueryKeys = {
  models: () => ['analysis', 'models'] as const,
  documentAnalyses: (documentId: string) => ['analysis', 'document', documentId] as const,
  run: (id: string) => ['analysis', 'run', id] as const,
  segments: (id: string, query?: AnalysisSegmentsQuery) => ['analysis', 'segments', id, query ?? null] as const,
  reviewDocument: (id: string) => ['analysis', 'review-document', id] as const,
  segmentContext: (analysisId: string, segmentId: string) => ['analysis', 'segment-context', analysisId, segmentId] as const,
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

export function getAnalysisSegments(analysisId: string, query?: AnalysisSegmentsQuery) {
  const params = query ? new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
    sort: query.sort,
    filter: query.filter,
  }) : null
  const suffix = params ? `?${params.toString()}` : ''
  return getJson(`/analyses/${analysisId}/segments${suffix}`, segmentListSchema)
}

export function getAnalysisReviewDocument(analysisId: string) {
  return getJson(
    `/analyses/${analysisId}/segments?includeDocumentText=true`,
    segmentListSchema,
  )
}

export function getAnalysisSegmentContext(analysisId: string, segmentId: string) {
  return getJson(`/analyses/${analysisId}/segments/${segmentId}/context`, analysisSegmentContextSchema)
}

export function compareAnalyses(baseAnalysisId: string, targetAnalysisId: string) {
  return postJson('/analyses/compare', comparisonSchema, { baseAnalysisId, targetAnalysisId })
}
