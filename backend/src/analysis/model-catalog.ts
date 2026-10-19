export type ModelHoldoutMetrics = {
  evaluationSet: 'F006_FINAL_HOLDOUT' | 'F006_1_FINAL_HOLDOUT' | 'F006_1_1_FINAL_HOLDOUT';
  operatingPoint: 'BALANCED' | 'F006_1_LOCKED_ES_ISO_THRESHOLD' | 'F006_1_1_LOCKED_DUAL_THRESHOLD';
  macroF1: number;
  overallHumanFpr: number;
  overallHumanFprCi95?: [number, number];
  spanishF1?: number | null;
  spanishHumanFpr: number;
  spanishHumanFprCi95?: [number, number];
  spanishRecall?: number | null;
  spanishEce?: number | null;
  academicHumanFpr: number;
  academicF1?: number | null;
  unseenGeneratorHumanFpr: number;
  oodHumanFpr?: number | null;
  unseenDomainHumanFpr?: number | null;
  unseenDomainF1?: number | null;
  mixedRecall: number;
  aiEditedF1: number;
  oodF1: number;
  unseenGeneratorF1?: number | null;
  adversarialRecall?: number | null;
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

export type ResearchModelMetadata = {
  sourceBranch?: string;
  sourceCommit: string;
  trainingCommit: string;
  trainingPhase: string;
  parentModel: string;
  sourceTrainingParent?: string;
  datasetName: string;
  datasetManifestHashes: Record<string, string>;
  datasetVersionId: string | null;
  artifactAvailableLocally: boolean;
  modelSha256?: string;
  artifactChecksumValidated: boolean;
  validationMetrics?: {
    evaluationSet: string;
    calibrationOption: string;
    selectedCheckpointStep: number;
    macroF1: number;
    overallHumanFpr: number;
    spanishMacroF1: number;
    spanishHumanFpr: number;
    spanishEce: number | null;
    selectionCheckpoint: {
      threshold: number;
      overallHumanFpr: number;
      spanishHumanFpr: number;
      academicHumanFpr: number;
      unseenGeneratorHumanFpr: number;
    };
  };
  calibration: {
    global: string;
    spanish: string;
    method?: string;
    globalMethod?: string;
    spanishMethod?: string;
    globalThreshold: number;
    spanishThreshold: number;
    spanishEce: number | null;
  };
  holdoutCounts?: {
    documents: number;
    humanDocuments: number;
    spanishDocuments: number;
    leakageCount: number;
  };
  gatesPassed: number;
  gatesTotal: number;
  failedGates: string[];
  paragraphStability: 'NOT_EVALUATED';
  strictSupported: 'UNVERIFIED_ARTIFACT_UNAVAILABLE';
  contextualSupported: 'UNVERIFIED_ARTIFACT_UNAVAILABLE';
  languageSelection:
    | 'UNVERIFIED_NO_LOCAL_LANGUAGE_DETECTOR'
    | 'EXPLICIT_LANGUAGE_CODE_REQUIRED';
  active: boolean;
  candidate: boolean;
  limitations: string[];
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
  researchMetadata?: ResearchModelMetadata;
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
  EXPERIMENTAL_F006_1_MODEL: {
    status: 'EXPERIMENTAL',
    architecture: 'microsoft/mdeberta-v3-base + V3 multi-task heads',
    variant: 'F006_1_SPANISH_GENERALIZATION_EXPERIMENTAL',
    dataset: 'F006_1',
    artifactProvider: 'GOOGLE_DRIVE',
    thresholdProfiles: [],
    thresholdSource: 'F006_1_MODEL_LOCK',
    preprocessing: ['V3_CANONICALIZED_V1'],
    metrics: {
      evaluationSet: 'F006_1_FINAL_HOLDOUT',
      operatingPoint: 'F006_1_LOCKED_ES_ISO_THRESHOLD',
      macroF1: 0.8913183115501333,
      overallHumanFpr: 0.05545454545454546,
      overallHumanFprCi95: [0.051330669224617376, 0.05988881615946885],
      spanishF1: 0.9192178110962022,
      spanishHumanFpr: 0.05490909090909091,
      spanishHumanFprCi95: [0.049193331328846165, 0.06124618422697943],
      spanishRecall: 0.8916,
      spanishEce: 0.0097,
      academicHumanFpr: 0.016331658291457288,
      academicF1: 0.928611936781685,
      unseenGeneratorHumanFpr: 0.1075,
      oodHumanFpr: 0.044,
      unseenDomainHumanFpr: 0.06,
      unseenDomainF1: 0.8394262163464112,
      mixedRecall: 0.63,
      aiEditedF1: 0.9237804308497959,
      oodF1: 0.9419886297714353,
      unseenGeneratorF1: 0.8768449328449328,
      adversarialRecall: 0.8725,
      zeroWidthF1: 0.88,
      homoglyphF1: 0.879,
      spanTokenF1: 0.826,
    },
    strengths: ['Mejor F1 global y español del holdout F006.1; este resultado no recomienda activación.'],
    warnings: [
      'Gates fallidos: A overall FPR, D unseen-generator FPR, E mixed recall, H span F1.',
      'La estabilidad por párrafo no fue evaluada.',
      'El holdout final ya fue observado y no se reutiliza para tuning.',
    ],
    officialGates: {
      A_overall_human_fpr_le_0_05: false,
      B_spanish_human_fpr_le_0_08: true,
      C_academic_human_fpr_le_0_05: true,
      D_unseen_generator_fpr_le_0_10: false,
      E_mixed_recall_ge_0_64: false,
      F_ai_edited_f1_ge_0_81: true,
      G_ood_f1_ge_0_90_or_drop_le_0_04: true,
      H_span_f1_ge_0_86: false,
      I_zero_width_homoglyph_no_severe_regression: true,
      J_leakage_0: true,
      K_holdout_not_used_for_tuning: true,
    },
    promotionEvidence: {
      mixedAiEdited: false,
      robustness: true,
      paragraphStability: null,
      noLeakage: true,
      holdoutNeverTuned: true,
    },
    researchMetadata: {
      sourceBranch: 'exp/f006-1-spanish-generalization',
      sourceCommit: '714cdafe39977002ee9b84791a4bd8dca05cc57a',
      trainingCommit: '52c71d7ee9bedf5e6afc55b48499039db4d74497',
      trainingPhase: 'F006.1',
      parentModel: 'CANDIDATE_MODEL_V3',
      sourceTrainingParent: 'B1_v3',
      datasetName: 'F006_1_FINAL_HOLDOUT',
      datasetManifestHashes: {
        holdout: 'cd9717a894e9da82cbc5491e4ee9aab993df90edc7dc2bba735730d1234cfbcb',
        validation: '493cd53fdcc12d37fdd834fb3976fff73c07711c3932f3f4a0a87fbfe082a55c',
        trainExtra: '7634d2891c3833230194c28d9583222eb5a7f9d92dbb36a8e1faa55eba393979',
      },
      datasetVersionId: null,
      artifactAvailableLocally: false,
      modelSha256: 'c451a0062321189f026a1cc3779f50aa1b398a580d4cedfb9365a9486c835a90',
      artifactChecksumValidated: false,
      validationMetrics: {
        evaluationSet: 'F006_1_VALIDATION',
        calibrationOption: 'ES_ISO',
        selectedCheckpointStep: 2400,
        macroF1: 0.9109,
        overallHumanFpr: 0.0478,
        spanishMacroF1: 0.9155,
        spanishHumanFpr: 0.0442,
        spanishEce: 0.0064,
        selectionCheckpoint: {
          threshold: 0.9707,
          overallHumanFpr: 0.0648,
          spanishHumanFpr: 0.0627,
          academicHumanFpr: 0.0274,
          unseenGeneratorHumanFpr: 0.0387,
        },
      },
      calibration: {
        global: 'GLOBAL_ISO',
        spanish: 'ES_ISO',
        method: 'isotonic',
        globalThreshold: 0.6443,
        spanishThreshold: 0.6443,
        spanishEce: 0.0097,
      },
      gatesPassed: 7,
      gatesTotal: 11,
      failedGates: [
        'A_overall_human_fpr_le_0.05',
        'D_unseen_generator_fpr_le_0.10',
        'E_mixed_recall_ge_0.64',
        'H_span_f1_ge_0.86',
      ],
      paragraphStability: 'NOT_EVALUATED',
      strictSupported: 'UNVERIFIED_ARTIFACT_UNAVAILABLE',
      contextualSupported: 'UNVERIFIED_ARTIFACT_UNAVAILABLE',
      languageSelection: 'UNVERIFIED_NO_LOCAL_LANGUAGE_DETECTOR',
      active: false,
      candidate: false,
      limitations: [
        'No pasa el gate de FPR humano global (0.055 > 0.05).',
        'No pasa el gate de FPR de generador no visto (0.107 > 0.10).',
        'No pasa el gate de recall mixto (0.630 < 0.64).',
        'No pasa el gate de span F1 (0.826 < 0.86).',
        'Estabilidad por párrafo no evaluada.',
        'No hay promoción de candidato ni modelo activo.',
        'La selección de idioma entre GLOBAL_ISO y ES_ISO no está conectada ni validada en serving local.',
        'El holdout final no se reutiliza para tuning.',
      ],
    },
  },
  EXPERIMENTAL_F006_1_1_MODEL: {
    status: 'EXPERIMENTAL',
    architecture: 'microsoft/mdeberta-v3-base + V3 multi-task heads',
    variant: 'F006_1_1_DUAL_CALIBRATION_EXPERIMENTAL',
    dataset: 'F006_1_1',
    artifactProvider: 'GOOGLE_DRIVE',
    thresholdProfiles: ['BALANCED'],
    thresholdSource: 'F006_1_1_VALIDATION_LOCK',
    preprocessing: ['V3_CANONICALIZED_V1'],
    metrics: {
      evaluationSet: 'F006_1_1_FINAL_HOLDOUT',
      operatingPoint: 'F006_1_1_LOCKED_DUAL_THRESHOLD',
      macroF1: 0.8704,
      overallHumanFpr: 0.0541,
      spanishHumanFpr: 0.019,
      academicHumanFpr: 0.0307,
      unseenGeneratorHumanFpr: 0.0967,
      mixedRecall: 0.5832,
      aiEditedF1: 0.9023,
      oodF1: 0.9383,
      zeroWidthF1: 0.8609,
      homoglyphF1: 0.8609,
      spanTokenF1: 0.7694,
    },
    strengths: [],
    warnings: [
      'Experimental research model; it is not ACTIVE or a candidate.',
      'The F006.1.1 checkpoint is not present locally, so this model is not servable.',
      'The available report does not lock a SHA-256 digest for the F006.1.1 weight files.',
      'The unified document-plus-span ensemble is not implemented or available.',
    ],
    officialGates: {
      A_overall_human_fpr_le_0_05: false,
      H_mixed_recall_ge_0_65: false,
      I_span_token_f1_ge_0_86: false,
    },
    promotionEvidence: {
      mixedAiEdited: false,
      robustness: true,
      paragraphStability: null,
      noLeakage: true,
      holdoutNeverTuned: true,
    },
    researchMetadata: {
      sourceCommit: '0ad01f5fb75b48cdd1cce3a9b0084511253a69f1',
      trainingCommit: '632dc6f7a852ee9c1dfc511a35a76cd1ce63428e',
      trainingPhase: 'F006.1.1',
      parentModel: 'EXPERIMENTAL_F006_MODEL',
      sourceTrainingParent: 'C3_f006',
      datasetName: 'F006_1_1_FINAL_HOLDOUT',
      datasetManifestHashes: {},
      datasetVersionId: null,
      artifactAvailableLocally: false,
      artifactChecksumValidated: false,
      calibration: {
        global: 'GLOBAL_ISO',
        spanish: 'ES_PLATT',
        globalMethod: 'isotonic',
        spanishMethod: 'platt',
        globalThreshold: 0.767241379310345,
        spanishThreshold: 0.767241379310345,
        spanishEce: null,
      },
      holdoutCounts: {
        documents: 30363,
        humanDocuments: 13650,
        spanishDocuments: 5530,
        leakageCount: 0,
      },
      gatesPassed: 8,
      gatesTotal: 11,
      failedGates: [
        'A_overall_human_fpr_le_0.05',
        'H_mixed_recall_ge_0.65',
        'I_span_token_f1_ge_0.86',
      ],
      paragraphStability: 'NOT_EVALUATED',
      strictSupported: 'UNVERIFIED_ARTIFACT_UNAVAILABLE',
      contextualSupported: 'UNVERIFIED_ARTIFACT_UNAVAILABLE',
      languageSelection: 'EXPLICIT_LANGUAGE_CODE_REQUIRED',
      active: false,
      candidate: false,
      limitations: [
        'FPR humano global: 0.0541, por encima del gate 0.05.',
        'Recall mixto: 0.5832, por debajo del gate H de 0.65.',
        'Span token F1: 0.7694, por debajo del gate I de 0.86.',
        'Estabilidad por párrafo no evaluada.',
        'El artefacto de 1.11 GB no está instalado localmente; el modelo permanece no disponible.',
        'El reporte disponible no fija un SHA-256 para validar los pesos del checkpoint.',
        'El modelo no está ACTIVE ni es candidato; el holdout no se reutiliza para tuning.',
      ],
    },
  },
};

export const NON_SERVING_RESEARCH_MODELS = [
  {
    name: 'EXPERIMENTAL_SPAN_MODEL_V1',
    status: 'EXPERIMENTAL',
    active: false,
    candidate: false,
    registeredForServing: false,
    servable: false,
    spanServingReady: false,
    note: 'Metadata de investigación solamente; no se carga en serving ni produce resaltados.',
  },
] as const;

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
