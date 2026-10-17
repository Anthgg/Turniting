import { describe, expect, it } from 'vitest'
import { analyzerModelListSchema, comparisonSchema, segmentListSchema } from '../../api/analysis'
import {
  analysisErrorMessage,
  availabilityLabel,
  formatDelta,
  formatSignal,
  isAnalyzerUsable,
  signalLevel,
} from './analysis-utils'

describe('analysis presentation', () => {
  it('uses neutral bands and percentages', () => {
    expect(signalLevel(0.12)).toBe('LOW')
    expect(signalLevel(0.5)).toBe('MODERATE')
    expect(signalLevel(0.81)).toBe('HIGH')
    expect(signalLevel(null)).toBeNull()
    expect(formatSignal(0.81)).toBe('81 %')
    expect(formatDelta(-0.07)).toBe('-7 pp')
    expect(formatDelta(0.03)).toBe('+3 pp')
  })

  it('explains a missing model without a generic application error', () => {
    expect(analysisErrorMessage('MODEL_UNAVAILABLE', 503)).toMatch(/no está disponible/)
    expect(availabilityLabel('UNAVAILABLE')).toBe('Registrado · faltan pesos')
    expect(isAnalyzerUsable('UNAVAILABLE')).toBe(false)
    expect(isAnalyzerUsable('READY')).toBe(true)
  })

  it('parses model status, paragraph results and version comparisons', () => {
    const models = analyzerModelListSchema.parse({ aiServiceReachable: true, items: [{
      name: 'CANDIDATE_MODEL_V3', id: null, registeredInDatabase: false, status: 'CANDIDATE', architecture: 'x',
      variant: null, dataset: 'TURNITING_DATASET_V2', availability: 'UNAVAILABLE', artifactPresent: false,
      servable: true, thresholdProfiles: [], thresholdSource: null, preprocessing: ['V3_CANONICALIZED_V1'], warnings: [] }] })
    expect(models.items[0].availability).toBe('UNAVAILABLE')
    const segments = segmentListSchema.parse({ analysisId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', stale: false, items: [
      { paragraphIndex: 0, charStart: 0, charEnd: 10, pageNumber: null, words: 2, calibratedScore: 0.12,
        classification: 'LOW_SIGNAL', signalLevel: 'LOW', confidence: 'HIGH', text: 'Párrafo 1' },
      { paragraphIndex: 1, charStart: 12, charEnd: 20, pageNumber: 2, words: 1, calibratedScore: null,
        classification: 'INSUFFICIENT_TEXT', signalLevel: null, confidence: null, text: 'Título' }] })
    expect(segments.items[1].classification).toBe('INSUFFICIENT_TEXT')
    const comparison = comparisonSchema.parse({ id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', documentSimilarity: 0.9,
      globalScoreDelta: -0.07, changedSegments: 1, unchangedSegments: 1, addedSegments: 0, removedSegments: 0,
      disclaimer: 'not a Turnitin score', details: { baseDocumentScore: 0.31, targetDocumentScore: 0.24,
        unchangedDrift: { n: 1, mean: 0.01, median: 0.01, p90: 0.01, p95: 0.01, max: 0.01 }, paragraphs: [
          { status: 'MODIFIED', baseParagraphIndex: 11, targetParagraphIndex: 11, similarity: 0.7, baseScore: 0.71,
            targetScore: 0.34, delta: -0.37 },
          { status: 'UNCHANGED', baseParagraphIndex: 12, targetParagraphIndex: 12, similarity: 1, baseScore: 0.18,
            targetScore: 0.17, delta: -0.01 }] } })
    expect(formatDelta(comparison.details.paragraphs[0].delta)).toBe('-37 pp')
  })
})
