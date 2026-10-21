import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { analyzerModelListSchema } from '../../api/analysis'
import { ModelsOverview } from './ModelsPage'

const modelList = analyzerModelListSchema.parse({
  aiServiceReachable: true,
  activeModel: 'NONE',
  localPreferredAnalyzer: 'V3_ONLY',
  localPreferredAvailable: true,
  resolvedLocalPreferredAnalyzer: 'CANDIDATE_MODEL_V3',
  localPreferredFallback: 'CANDIDATE_MODEL_V2',
  localPreferredFallbackAvailable: true,
  items: [{
    name: 'CANDIDATE_MODEL_V3',
    id: 'synthetic-model-id',
    registeredInDatabase: true,
    registeredInRegistry: true,
    status: 'CANDIDATE',
    architecture: 'Synthetic transformer',
    variant: 'synthetic-v3',
    dataset: 'SYNTHETIC_DATASET',
    availability: 'AVAILABLE',
    available: true,
    active: false,
    candidate: true,
    artifactPresent: false,
    artifactValid: false,
    servable: true,
    thresholdProfiles: ['BALANCED'],
    thresholdSource: 'SYNTHETIC_THRESHOLD_SOURCE',
    thresholds: { BALANCED: 0.5 },
    preprocessing: ['SYNTHETIC_PREPROCESSING'],
    warnings: ['SPANISH_FPR_REGRESSION'],
    metrics: {
      evaluationSet: 'SYNTHETIC_ONLY',
      operatingPoint: 'BALANCED',
      macroF1: 0.83,
      overallHumanFpr: 0.04,
      spanishHumanFpr: 0.09,
      academicHumanFpr: 0.03,
      unseenGeneratorHumanFpr: 0.08,
      mixedRecall: 0.7,
      aiEditedF1: 0.81,
      oodF1: 0.75,
      zeroWidthF1: 0.79,
      homoglyphF1: 0.78,
    },
    activeGateResults: {
      overallHumanFpr: { observed: 0.04, limit: 0.05, passed: true },
      spanishHumanFpr: { observed: 0.09, limit: 0.08, passed: false },
      academicHumanFpr: { observed: 0.03, limit: 0.05, passed: true },
      unseenGeneratorHumanFpr: { observed: 0.08, limit: 0.1, passed: true },
    },
  }],
})

describe('ModelsOverview', () => {
  it('surfaces friendly availability and resolved preference while keeping technical values collapsed', () => {
    const markup = renderToStaticMarkup(<ModelsOverview modelList={modelList} />)

    expect(markup).toContain('Preferencia local resuelta')
    expect(markup).toContain('Preferencia configurada: Modelo V3.')
    expect(markup).toContain('Modelo V3')
    expect(markup).toContain('Disponible para análisis')
    expect(markup).toContain('Preferido para análisis')
    expect(markup).toContain('Disponible')
    expect(markup).toContain('La tasa de falsos positivos en personas en español es elevada.')
    expect(markup).toContain('Detalles técnicos')
    expect(markup).toContain('synthetic-model-id')
    expect(markup).toContain('SYNTHETIC_THRESHOLD_SOURCE')
    expect(markup).toContain('SYNTHETIC_ONLY')
    expect(markup).toContain('spanishHumanFpr')
    expect(markup).not.toMatch(/<details[^>]*\sopen(?:="")?/i)
  })
})
