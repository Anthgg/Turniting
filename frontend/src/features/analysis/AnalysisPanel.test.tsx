import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryMocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}))

vi.mock('@tanstack/react-query', () => queryMocks)

import { AnalysisPanel } from './AnalysisPanel'

const RUN_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

function modelList() {
  return {
    data: {
      items: [
        { name: 'ENSEMBLE_V2_V3', servable: true, availability: 'COMPOSITE_AVAILABLE' },
        { name: 'CANDIDATE_MODEL_V2', servable: true, availability: 'AVAILABLE' },
        { name: 'CANDIDATE_MODEL_V3', servable: true, availability: 'READY' },
        { name: 'EXPERIMENTAL_F006_MODEL', servable: false, availability: 'UNAVAILABLE' },
      ],
    },
    isError: false,
  }
}

function historyQuery(isError = false, status = 'COMPLETED', paragraphMode = 'CONTEXTUAL_PARAGRAPH') {
  return {
    data: {
      items: [{
        id: RUN_ID,
        status,
        analyzerMode: 'V3_ONLY',
        analyzerVersion: 'f005-local-analyzer-v1',
        thresholdProfile: 'LOW_FALSE_POSITIVE',
        threshold: 0.8,
        paragraphMode,
        documentAggregation: 'token_weighted_mean',
        documentScore: 0.655,
        documentScorePercent: 66,
        documentClassification: 'MACHINE_SIGNAL',
        signalLevel: 'HIGH',
        scoredSegments: 1,
        insufficientSegments: 0,
        inferenceMs: 1250,
        errorCode: null,
        createdAt: '2026-10-17T12:00:00.000Z',
        completedAt: '2026-10-17T12:00:01.250Z',
        metadata: { cacheHit: false },
        modelResults: [{ modelName: 'CANDIDATE_MODEL_V3', calibratedScore: 0.655 }],
      }],
    },
    error: isError ? new Error('synthetic history failure') : null,
    isError,
    refetch: vi.fn(),
  }
}

function segmentsQuery(analysisId = RUN_ID, isError = false) {
  return {
    data: {
      analysisId,
      stale: false,
      page: 1,
      pageSize: 20,
      total: 1,
      pages: 1,
      items: [{
        id: '00000000-0000-4000-8000-000000000011',
        paragraphIndex: 0,
        charStart: 0,
        charEnd: 25,
        pageNumber: null,
        words: 4,
        tokens: 5,
        modelName: 'CANDIDATE_MODEL_V3',
        rawScore: 0.3,
        calibratedScore: 0.3,
        classification: 'LOW_SIGNAL',
        signalLevel: 'LOW',
        confidence: 'HIGH',
        text: 'Synthetic run paragraph',
      }],
    },
    error: isError ? new Error('synthetic segments failure') : null,
    isError,
    refetch: vi.fn(),
  }
}

function contextQuery() {
  return { data: undefined, error: null, isError: false, isPending: false, refetch: vi.fn() }
}

function renderPanel({
  historyError = false,
  segmentsRunId = RUN_ID,
  segmentsError = false,
  analysisError = false,
  runStatus = 'COMPLETED',
  paragraphMode = 'CONTEXTUAL_PARAGRAPH',
}: {
  historyError?: boolean
  segmentsRunId?: string
  segmentsError?: boolean
  analysisError?: boolean
  runStatus?: string
  paragraphMode?: string
} = {}) {
  queryMocks.useQuery
    .mockReturnValueOnce(modelList())
    .mockReturnValueOnce(historyQuery(historyError, runStatus, paragraphMode))
    .mockReturnValueOnce(segmentsQuery(segmentsRunId, segmentsError))
    .mockReturnValueOnce(contextQuery())
  queryMocks.useMutation.mockReturnValue({
    error: analysisError ? new Error('synthetic analysis failure') : null,
    isError: analysisError,
    isPending: false,
    mutate: vi.fn(),
  })
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    null,
    createElement(AnalysisPanel, {
      documentId: '7d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
      fileName: 'synthetic.docx',
      hasText: true,
      researchMode: true,
    }),
  ))
}

describe('AnalysisPanel run provenance and operation errors', () => {
  beforeEach(() => {
    queryMocks.useQuery.mockReset()
    queryMocks.useMutation.mockReset()
    queryMocks.useQueryClient.mockClear()
  })

  it('suppresses the fatal analysis error for a completed run and scopes secondary errors locally', () => {
    const html = renderPanel({ historyError: true, segmentsError: true, analysisError: true })

    expect(html).toContain('66 %')
    expect(html).toContain('token_weighted_mean')
    expect(html).toContain('Con contexto breve')
    expect(html).toContain('Solo el párrafo')
    expect(html).not.toContain('No se pudo completar el análisis solicitado.')
    expect(html).toContain('No se pudo cargar el historial de análisis.')
    expect(html).toContain('No se pudieron cargar los párrafos de este análisis.')
    expect(html).toContain('Synthetic run paragraph')
  })

  it('keeps a contextual run label from history while the new analysis form defaults to strict', () => {
    const html = renderPanel()

    expect(html).toContain('Con contexto breve')
    expect(html).toContain('Solo el párrafo')
    expect(html).toContain('66 %')
    expect(html).toContain('Contexto utilizado')
  })

  it('does not show a context badge or drawer action for a strict historical run', () => {
    const html = renderPanel({ paragraphMode: 'STRICT_PARAGRAPH' })

    expect(html).toContain('Modo de párrafo')
    expect(html).toContain('Solo el párrafo')
    expect(html).not.toContain('Contexto utilizado')
    expect(html).not.toContain('Ver contexto utilizado')
  })

  it('renders a collapsed context drawer trigger for contextual paragraphs', () => {
    const html = renderPanel()

    expect(html).toContain('Ver contexto utilizado')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('analysis-context-drawer')
  })

  it('keeps the analysis retry for a failed run', () => {
    const html = renderPanel({ analysisError: true, runStatus: 'FAILED' })

    expect(html).toContain('No se pudo completar el análisis solicitado.')
    expect(html).toContain('Reintentar análisis')
  })

  it('does not render segments returned for a different analysisRunId', () => {
    const html = renderPanel({ segmentsRunId: '9a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' })

    expect(html).toContain('66 %')
    expect(html).toContain('La respuesta de párrafos no corresponde al análisis seleccionado')
    expect(html).not.toContain('Synthetic run paragraph')
  })
})
