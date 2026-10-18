export type ModelHoldoutMetrics = {
  evaluationSet: 'F006_FINAL_HOLDOUT';
  operatingPoint: 'BALANCED';
  macroF1: number;
  overallHumanFpr: number;
  spanishHumanFpr: number;
  academicHumanFpr: number;
  unseenGeneratorHumanFpr: number;
  oodHumanFpr: number;
  unseenDomainHumanFpr: number;
  mixedRecall: number;
  aiEditedF1: number;
  oodF1: number;
  unseenGeneratorF1: number;
  adversarialRecall: number;
  zeroWidthF1: number;
  homoglyphF1: number;
  spanTokenF1?: number | null;
};

export type PromotionEvidence = {
  mixedAiEdited: boolean | null;
  robustness: boolean | null;
  paragraphStability: boolean | null;
  noLeakage: boolean | null;
  holdoutNeverTuned: boolean | null;
};

export type ModelCatalogEntry = {
  status: 'CANDIDATE' | 'EXPERIMENTAL';
  architecture: string;
  variant: string;
  dataset: string;
  artifactProvider: string;
  thresholdProfiles: string[];
  thresholdSource: string | null;
  preprocessing: string[];
  metrics: ModelHoldoutMetrics | null;
  strengths: string[];
  warnings: string[];
  officialGates: Record<string, boolean> | null;
  promotionEvidence: PromotionEvidence;
};

const F006_HOLDOUT = 'F006_FINAL_HOLDOUT' as const;
const BALANCED = 'BALANCED' as const;
const UNASSESSED_PROMOTION_EVIDENCE: PromotionEvidence = {
  mixedAiEdited: null,
  robustness: null,
  paragraphStability: null,
  noLeakage: null,
  holdoutNeverTuned: null,
};

export const MODEL_CATALOG: Record<string, ModelCatalogEntry> = {
  BEST_BASELINE: {
    status: 'EXPERIMENTAL',
    architecture: 'stacked TF-IDF LR/SVM + stylometric GBM',
    variant: 'ENSEMBLE_TFIDF_STYLOMETRIC',
    dataset: 'TURNITING_DATASET_V1',
    artifactProvider: 'LOCAL',
    thresholdProfiles: [],
    thresholdSource: null,
    preprocessing: ['V2_PREPROCESSING_V1'],
    metrics: null,
    strengths: [],
    warnings: ['No result is recorded for BEST_BASELINE in the F006 final holdout.'],
    officialGates: null,
    promotionEvidence: UNASSESSED_PROMOTION_EVIDENCE,
  },
  CANDIDATE_MODEL_V2: {
    status: 'CANDIDATE',
    architecture: 'microsoft/mdeberta-v3-base',
    variant: 'CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER_GPU',
    dataset: 'TURNITING_DATASET_V1',
    artifactProvider: 'GOOGLE_DRIVE',
    thresholdProfiles: ['BALANCED', 'LOW_FALSE_POSITIVE', 'VERY_LOW_FALSE_POSITIVE'],
    thresholdSource: 'f005-v1',
    preprocessing: ['V2_PREPROCESSING_V1'],
    metrics: {
      evaluationSet: F006_HOLDOUT,
      operatingPoint: BALANCED,
      macroF1: 0.6203,
      overallHumanFpr: 0.0431,
      spanishHumanFpr: 0.1161,
      academicHumanFpr: 0.0142,
      unseenGeneratorHumanFpr: 0.04,
      oodHumanFpr: 0.0673,
      unseenDomainHumanFpr: 0.0233,
      mixedRecall: 0.1125,
      aiEditedF1: 0.5092,
      oodF1: 0.6603,
      unseenGeneratorF1: 0.765,
      adversarialRecall: 0.41,
      zeroWidthF1: 0.331,
      homoglyphF1: 0.4718,
      spanTokenF1: null,
    },
    strengths: [],
    warnings: [
      'Spanish human false-positive rate exceeds the ACTIVE limit.',
      'Mixed, AI-edited, and adversarial results are limited in the F006 holdout.',
    ],
    officialGates: null,
    promotionEvidence: UNASSESSED_PROMOTION_EVIDENCE,
  },
  CANDIDATE_MODEL_V3: {
    status: 'CANDIDATE',
    architecture: 'microsoft/mdeberta-v3-base',
    variant: 'TURNITING_RESEARCH_V3_SPANISH_ACADEMIC',
    dataset: 'TURNITING_DATASET_V2',
    artifactProvider: 'GOOGLE_DRIVE',
    thresholdProfiles: ['BALANCED', 'LOW_FALSE_POSITIVE', 'VERY_LOW_FALSE_POSITIVE'],
    thresholdSource: 'f005-v1',
    preprocessing: ['V3_CANONICALIZED_V1'],
    metrics: {
      evaluationSet: F006_HOLDOUT,
      operatingPoint: BALANCED,
      macroF1: 0.8299,
      overallHumanFpr: 0.0616,
      spanishHumanFpr: 0.1827,
      academicHumanFpr: 0.0031,
      unseenGeneratorHumanFpr: 0.0892,
      oodHumanFpr: 0.0107,
      unseenDomainHumanFpr: 0.0433,
      mixedRecall: 0.681,
      aiEditedF1: 0.8524,
      oodF1: 0.9257,
      unseenGeneratorF1: 0.8177,
      adversarialRecall: 0.769,
      zeroWidthF1: 0.8407,
      homoglyphF1: 0.8386,
      spanTokenF1: 0.885,
    },
    strengths: [],
    warnings: [
      'Overall and Spanish human false-positive rates exceed the ACTIVE limits.',
      'F006 final-holdout results do not include a paragraph-stability result for this model.',
    ],
    officialGates: null,
    promotionEvidence: UNASSESSED_PROMOTION_EVIDENCE,
  },
  ENSEMBLE_V2_V3: {
    status: 'EXPERIMENTAL',
    architecture: 'weighted probability ensemble',
    variant: 'ENSEMBLE_V2_V3_BALANCED',
    dataset: 'TURNITING_DATASET_V2',
    artifactProvider: 'COMPOSITE',
    thresholdProfiles: ['BALANCED', 'LOW_FALSE_POSITIVE', 'VERY_LOW_FALSE_POSITIVE'],
    thresholdSource: 'f005-v1',
    preprocessing: ['V2_PREPROCESSING_V1', 'V3_CANONICALIZED_V1'],
    metrics: {
      evaluationSet: F006_HOLDOUT,
      operatingPoint: BALANCED,
      macroF1: 0.6679,
      overallHumanFpr: 0.0369,
      spanishHumanFpr: 0.1212,
      academicHumanFpr: 0.0009,
      unseenGeneratorHumanFpr: 0.0548,
      oodHumanFpr: 0.0093,
      unseenDomainHumanFpr: 0.0187,
      mixedRecall: 0.1845,
      aiEditedF1: 0.5827,
      oodF1: 0.7278,
      unseenGeneratorF1: 0.7894,
      adversarialRecall: 0.477,
      zeroWidthF1: 0.3332,
      homoglyphF1: 0.5737,
      spanTokenF1: null,
    },
    strengths: [],
    warnings: [
      'Spanish human false-positive rate exceeds the ACTIVE limit.',
      'Mixed, AI-edited, and adversarial results are limited in the F006 holdout.',
      'Experimental development recommendation only; not ACTIVE.',
    ],
    officialGates: null,
    promotionEvidence: UNASSESSED_PROMOTION_EVIDENCE,
  },
  EXPERIMENTAL_F006_MODEL: {
    status: 'EXPERIMENTAL',
    architecture: 'microsoft/mdeberta-v3-base + V3 multi-task heads (binary / fine / token)',
    variant: 'F006_TRANSFORMER_EXPERIMENTAL',
    dataset: 'TURNITING_DATASET_V2',
    artifactProvider: 'GOOGLE_DRIVE',
    thresholdProfiles: ['BALANCED', 'LOW_FALSE_POSITIVE', 'VERY_LOW_FALSE_POSITIVE'],
    thresholdSource: 'F006_ISOTONIC_V1',
    preprocessing: ['V3_CANONICALIZED_V1'],
    metrics: {
      evaluationSet: F006_HOLDOUT,
      operatingPoint: BALANCED,
      macroF1: 0.8314,
      overallHumanFpr: 0.0447,
      spanishHumanFpr: 0.1423,
      academicHumanFpr: 0.0025,
      unseenGeneratorHumanFpr: 0.0692,
      oodHumanFpr: 0.0133,
      unseenDomainHumanFpr: 0.018,
      mixedRecall: 0.6695,
      aiEditedF1: 0.8616,
      oodF1: 0.9308,
      unseenGeneratorF1: 0.8308,
      adversarialRecall: 0.7475,
      zeroWidthF1: 0.8215,
      homoglyphF1: 0.8194,
      spanTokenF1: 0.888,
    },
    strengths: [
      'Low overall human false-positive rate',
      'Strong academic and OOD performance',
      'Improved unseen-generator results',
    ],
    warnings: [
      'SPANISH_FPR_REGRESSION',
      'SPANISH_VALIDATION_SHIFT',
      'Spanish human false-positive rate is elevated.',
    ],
    officialGates: {
      A_holdout_human_fpr_le_0_05: true,
      B_unseen_generator_fpr_le_0_10_or_clear_gain: true,
      C_academic_strong: true,
      D_spanish_strong: false,
      E_mixed_recall_drop_le_5pts: true,
      F_ai_edited_f1_drop_le_5pts: true,
      G_ood_no_severe_drop: true,
      H_zero_width_homoglyph_robust: true,
      I_no_leakage: true,
      J_holdout_never_used_for_tuning: true,
    },
    promotionEvidence: {
      mixedAiEdited: true,
      robustness: true,
      paragraphStability: null,
      noLeakage: true,
      holdoutNeverTuned: true,
    },
  },
};

export const ACTIVE_ACCEPTANCE_LIMITS = {
  overallHumanFpr: 0.05,
  spanishHumanFpr: 0.08,
  academicHumanFpr: 0.05,
  unseenGeneratorHumanFpr: 0.1,
} as const;

export function numericGateResults(metrics: ModelHoldoutMetrics | null) {
  if (!metrics) return null;
  return Object.fromEntries(
    Object.entries(ACTIVE_ACCEPTANCE_LIMITS).map(([key, limit]) => {
      const observed = metrics[key as keyof typeof ACTIVE_ACCEPTANCE_LIMITS];
      return [key, { observed, limit, passed: observed <= limit }];
    }),
  );
}
