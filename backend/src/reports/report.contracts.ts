import type { ReviewEvidence, ReviewPresentation } from '../analysis/review-presentation.js';

export type ReportKind = 'AI_REPORT' | 'SIMILARITY_REPORT';

export type ReportState =
  'GENERATING' | 'AVAILABLE' | 'ERROR' | 'EXPIRED' | 'DELETED';

export interface AIReportEvidenceSpan {
  startChar: number;
  endChar: number;
  confidence?: number;
  label?: string;
}

export interface AIReportSegmentEvidence {
  type: 'PARAGRAPH' | 'SPAN';
  paragraphId: number;
  start: number;
  end: number;
  score: number | null;
  level: string | null;
  spans?: AIReportEvidenceSpan[];
}

export interface AIReportParagraph {
  paragraphIndex: number;
  textHash: string;
  charStart: number;
  charEnd: number;
  segmentEvidence: AIReportSegmentEvidence;
  reviewPresentation: ReviewPresentation;
  presentationExcluded?: boolean;
  excludedReason?: string | null;
  reviewEvidence?: ReviewEvidence;
  score: number | null;
  signalLevel: string | null;
  classification: string;
  textPreview: string;
  pageNumber: number | null;
  words: number | null;
  tokens: number | null;
  contextTokensBefore?: number;
  contextTokensAfter?: number;
  modelScores?: Array<{ modelName: string; score: number | null }>;
}

export interface AIReportHistoryItem {
  id: string;
  createdAt: Date;
  model: string;
  paragraphMode: string | null;
  score: number | null;
}

export interface AIReportInput {
  reportId: string;
  generatedAt: Date;
  turnitingVersion: string;
  document: {
    id: string;
    documentVersionId: string;
    filename: string;
    mimeType: string;
    sourceChecksum: string;
    storageKey: string;
    createdAt: Date;
    updatedAt: Date;
  };
  extractedText: string;
  run: {
    id: string;
    status: string;
    analyzerMode: string;
    analyzerVersion: string;
    thresholdProfile: string;
    threshold: number | null;
    paragraphMode: string | null;
    documentAggregation: string | null;
    documentScore: number | null;
    signalLevel: string | null;
    scoredSegments: number;
    insufficientSegments: number;
    inferenceMs: number | null;
    cacheHit: boolean;
    metadata?: unknown;
    createdAt: Date;
    completedAt: Date | null;
    modelNames: string[];
    modelVersions: string[];
  };
  paragraphs: AIReportParagraph[];
  history: AIReportHistoryItem[];
  limitations: string[];
}

export type SimilarityMatchType =
  | 'EXACT_MATCH'
  | 'NEAR_COPY'
  | 'PARAPHRASE_MATCH'
  | 'SOURCE_MATCH'
  | 'RELATED_NOT_COUNTED'
  | 'EXCLUDED';

export interface SimilarityMatch {
  queryStart: number;
  queryEnd: number;
  sourceStart?: number;
  sourceEnd?: number;
  queryText: string;
  sourceText?: string;
  matchType: SimilarityMatchType;
  matchedCoverage?: number;
  lexicalScore?: number;
  semanticScore?: number;
  rerankerScore?: number;
}

export interface SimilaritySource {
  sourceId: string;
  title: string;
  url?: string;
  contribution: number;
  bestScore: number;
  bestMatchType?: SimilarityMatchType;
  matches: SimilarityMatch[];
}

export interface SimilarityExclusion {
  label: string;
  count: number;
  tokens?: number;
}

/** Scores and contributions are proportions in [0, 1] supplied by the similarity pipeline. */
export interface SimilarityReportInput {
  reportId: string;
  generatedAt: Date;
  document: { id: string; filename: string; createdAt: Date };
  run: { id: string; createdAt: Date };
  similarityScore: number;
  matchedCoverage: number;
  eligibleTokens: number;
  matchedTokens: number;
  excludedTokens: number;
  sources: SimilaritySource[];
  exclusions?: SimilarityExclusion[];
  limitations: string[];
}

export interface ReportBundleManifest {
  reportIds: string[];
  generatedAt: string;
  expiresAt: string;
  verificationId?: string;
  reportHash?: string;
}
