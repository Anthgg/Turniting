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
import { groupParagraphSegments } from './analysis-utils'
import type { TechnicalPresentation } from '../../api/analysis'

const RUN_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

function modelList() {
  return {
    data: {
      items: [
        { name: 'ENSEMBLE_V2_V3', servable: true, availability: 'COMPOSITE_AVAILABLE' },
        { name: 'CANDIDATE_MODEL_V2', servable: true, availability: 'AVAILABLE' },
        { name: 'CANDIDATE_MODEL_V3', servable: true, availability: 'READY' },
        { name: 'EXPERIMENTAL_F006_MODEL', servable: false, availability: 'UNAVAILABLE' },
        { name: 'EXPERIMENTAL_F006_1_MODEL', servable: true, availability: 'AVAILABLE' },
        { name: 'EXPERIMENTAL_F006_1_1_MODEL', servable: false, availability: 'UNAVAILABLE' },
      ],
      resolvedLocalPreferredAnalyzer: 'EXPERIMENTAL_F006_1_MODEL',
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
        evaluatedSegments: 1,
        flaggedSegments: 1,
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

function reviewDocumentQuery() {
  const paragraphs = [
    { text: 'UNIVERSIDAD SINTÉTICA', level: 'HIGH', highlight: false, excludedReason: 'METADATA' },
    { text: 'Autor: Ana Ejemplo', level: 'HIGH', highlight: false, excludedReason: 'METADATA' },
    { text: '1.1 Identificación del problema', level: null, highlight: false, excludedReason: 'HEADING' },
    { text: 'Párrafo sintético con señal alta.', level: 'HIGH', highlight: true },
    { text: 'Párrafo sintético con señal moderada.', level: 'MODERATE', highlight: true },
    { text: 'Párrafo sintético con señal baja.', level: 'LOW', highlight: false },
    { text: 'Figura 1. Diagrama sintético.', level: 'HIGH', highlight: false, excludedReason: 'CAPTION' },
    { text: 'Referencias', level: null, highlight: false, excludedReason: 'REFERENCE_SECTION' },
    { text: 'Smith, A. (2024). Referencia sintética.', level: 'HIGH', highlight: false, excludedReason: 'REFERENCE_SECTION' },
  ];
  const documentText = paragraphs.map(({ text }) => text).join('\n\n');
  let offset = 0;
  const items = paragraphs.map((paragraph, paragraphIndex) => {
    const charStart = offset;
    const charEnd = charStart + paragraph.text.length;
    offset = charEnd + 2;
    return {
      id: `00000000-0000-4000-8000-${String(paragraphIndex + 1).padStart(12, '0')}`,
      paragraphIndex,
      charStart,
      charEnd,
      pageNumber: 1,
      words: paragraph.text.split(/\s+/u).length,
      tokens: 8,
      modelName: 'SYNTHETIC_MODEL_V3',
      rawScore: null,
      calibratedScore: paragraph.level === 'HIGH' ? 0.91 : paragraph.level === 'MODERATE' ? 0.49 : paragraph.level === 'LOW' ? 0.2 : null,
      classification: paragraph.level === null ? 'INSUFFICIENT_TEXT' : 'MACHINE_SIGNAL',
      signalLevel: paragraph.level,
      confidence: 'HIGH',
      text: paragraph.text,
      reviewPresentation: {
        highlight: paragraph.highlight,
        level: paragraph.level,
        ...(paragraph.excludedReason ? { excludedReason: paragraph.excludedReason } : {}),
      },
      ...(paragraph.level === 'MODERATE' ? {} : { evidence: {
        evaluated: paragraph.level !== null,
        flagged: paragraph.highlight || Boolean(paragraph.excludedReason && paragraph.level !== null),
        score: paragraph.level === 'HIGH' ? 0.91 : paragraph.level === 'MODERATE' ? 0.49 : paragraph.level === 'LOW' ? 0.2 : null,
        threshold: 0.8,
        presentationExcluded: Boolean(paragraph.excludedReason),
        ...(paragraph.excludedReason ? { excludedReason: paragraph.excludedReason } : {}),
        granularity: 'PARAGRAPH',
        paragraphFlagged: paragraph.highlight || Boolean(paragraph.excludedReason && paragraph.level !== null),
        spans: [],
      } }),
    };
  });
  return {
    data: { analysisId: RUN_ID, stale: false, documentText, items,
      reviewHighlightThreshold: 20 / 100, reviewHighlightComparator: 'GT', reviewHighlightedCount: 2 },
    isError: false,
    isPending: false,
    refetch: vi.fn(),
  };
}

function contextQuery() {
  return { data: undefined, error: null, isError: false, isPending: false, refetch: vi.fn() }
}

function technicalPresentationQuery() {
  const items = reviewDocumentQuery().data.items;
  const unit = (indices: number[], type: TechnicalPresentation['displayUnits'][number]['type'], label: string, excludedReason?: string): TechnicalPresentation['displayUnits'][number] => ({
    id: `unit-${indices.join('-')}`, type, label, sourceSegmentIds: indices, paragraphIndices: indices,
    positionStart: items[indices[0]].charStart, positionEnd: items[indices[indices.length - 1]].charEnd,
    text: indices.map((index) => items[index].text).join('\n'), presentationExcluded: Boolean(excludedReason),
    ...(excludedReason ? { excludedReason } : {}),
    evaluatedSegments: indices.flatMap((index) => {
      const segment = items[index];
      return segment.calibratedScore === null ? [] : [{ sourceSegmentId: segment.id, paragraphIndex: index, score: segment.calibratedScore, threshold: 0.8, flagged: segment.calibratedScore >= 0.8, reviewHighlighted: segment.reviewPresentation.highlight, presentationExcluded: Boolean(excludedReason), ...(excludedReason ? { excludedReason } : {}), text: segment.text }];
    }),
  });
  const data: TechnicalPresentation = {
    analysisRunId: RUN_ID,
    reviewHighlightThreshold: 20 / 100, reviewHighlightComparator: 'GT',
    counts: { totalSegments: 9, evaluatedSegments: 7, insufficientSegments: 2, rawFlaggedCount: 5, presentationExcludedFlagged: 4, actionableHighlightCount: 2, reviewHighlightedCount: 2, structuralGroups: 3 },
    actionableParagraphIndices: [3, 4],
    displayUnits: [unit([0, 1, 2], 'METADATA_GROUP', 'DATOS DE PORTADA', 'METADATA'), unit([3], 'EVALUATED_SEGMENT', 'SEGMENTO 4'), unit([4], 'EVALUATED_SEGMENT', 'SEGMENTO 5'), unit([5], 'EVALUATED_SEGMENT', 'SEGMENTO 6'), unit([6], 'CAPTION_GROUP', 'CAPTION', 'CAPTION'), unit([7, 8], 'REFERENCE_GROUP', 'REFERENCIAS', 'REFERENCE_SECTION')],
  };
  return { data, isPending: false, isError: false, refetch: vi.fn() };
}

function renderPanel({
  historyError = false,
  segmentsRunId = RUN_ID,
  segmentsError = false,
  analysisError = false,
  runStatus = 'COMPLETED',
  paragraphMode = 'CONTEXTUAL_PARAGRAPH',
  initialView = 'SUMMARY',
  initialDetailMode = 'GROUPED',
}: {
  historyError?: boolean
  segmentsRunId?: string
  segmentsError?: boolean
  analysisError?: boolean
  runStatus?: string
  paragraphMode?: string
  initialView?: 'SUMMARY' | 'REVIEW' | 'DETAIL'
  initialDetailMode?: 'GROUPED' | 'SEGMENTS'
} = {}) {
  queryMocks.useQuery
    .mockReturnValueOnce(modelList())
    .mockReturnValueOnce(historyQuery(historyError, runStatus, paragraphMode))
    .mockReturnValueOnce(segmentsQuery(segmentsRunId, segmentsError))
    .mockReturnValueOnce(reviewDocumentQuery())
    .mockReturnValueOnce(contextQuery())
    .mockReturnValueOnce(technicalPresentationQuery())
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
      initialView,
      initialDetailMode,
    }),
  ))
}

describe('AnalysisPanel run provenance and operation errors', () => {
  beforeEach(() => {
    queryMocks.useQuery.mockReset()
    queryMocks.useMutation.mockReset()
    queryMocks.useQueryClient.mockClear()
  })

  it('defaults research analysis to the available local F006.1 model', () => {
    const html = renderPanel()

    expect(html).toContain('<option value="F006_1_ONLY" selected="">F006.1 · Experimental</option>')
    expect(html).not.toContain('<option value="F006_1_1_ONLY"')
    expect(html).toContain('F006 base no disponible para inferencia')
  })

  it('suppresses the fatal analysis error for a completed run and scopes secondary errors locally', () => {
    const html = renderPanel({ historyError: true, segmentsError: true, analysisError: true, initialView: 'DETAIL', initialDetailMode: 'SEGMENTS' })

    expect(html).toContain('Con contexto breve')
    expect(html).toContain('Solo el párrafo')
    expect(html).not.toContain('No se pudo completar el análisis solicitado.')
    expect(html).toContain('No se pudo cargar el historial de análisis.')
    expect(html).toContain('No se pudieron cargar los párrafos de este análisis.')
    expect(html).toContain('Synthetic run paragraph')
  })

  it('keeps a contextual run label from history while the new analysis form defaults to strict', () => {
    const html = renderPanel({ initialView: 'DETAIL', initialDetailMode: 'SEGMENTS' })

    expect(html).toContain('Con contexto breve')
    expect(html).toContain('Solo el párrafo')
    expect(html).toContain('66 %')
    expect(html).toContain('Contexto utilizado')
  })

  it('does not show a context badge or drawer action for a strict historical run', () => {
    const html = renderPanel({ paragraphMode: 'STRICT_PARAGRAPH', initialView: 'DETAIL', initialDetailMode: 'SEGMENTS' })

    expect(html).toContain('Modo de párrafo')
    expect(html).toContain('Solo el párrafo')
    expect(html).not.toContain('Contexto utilizado')
    expect(html).not.toContain('Ver contexto utilizado')
  })

  it('renders a collapsed context drawer trigger for contextual paragraphs', () => {
    const html = renderPanel({ initialView: 'DETAIL', initialDetailMode: 'SEGMENTS' })

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
    const html = renderPanel({ segmentsRunId: '9a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', initialView: 'DETAIL', initialDetailMode: 'SEGMENTS' })

    expect(html).toContain('La respuesta de párrafos no corresponde al análisis seleccionado')
    expect(html).not.toContain('Synthetic run paragraph')
  })

  it('renders summary and detail as separate tabs while retaining the existing detail controls', () => {
    const summary = renderPanel({ paragraphMode: 'STRICT_PARAGRAPH', initialView: 'SUMMARY' })
    const detail = renderPanel({ paragraphMode: 'STRICT_PARAGRAPH', initialView: 'DETAIL', initialDetailMode: 'SEGMENTS' })

    expect(summary).toContain('analysis-view-tabs');
    expect(summary).toContain('analysis-summary-band');
    expect(summary).toContain('analysis-hero-metric');
    expect(summary).toContain('analysis-distribution');
    expect(summary).toContain('analysis-meta-grid');
    expect(summary).not.toContain('<div class="analysis-detail-view"');
    expect(detail).toContain('analysis-detail-view');
    expect(detail).toContain('analysis-heatmap-strip');
    expect(detail).toContain('analysis-paragraph-tech');
    expect(detail).toContain('Ver en Revisión');
    expect(detail).not.toContain('document-panel analysis-panel');
  })

  it('renders the complete review copy in document order with one threshold highlight style', () => {
    const html = renderPanel({ initialView: 'REVIEW' });
    const positions = [
      'UNIVERSIDAD SINTÉTICA',
      'Autor: Ana Ejemplo',
      '1.1 Identificación del problema',
      'Párrafo sintético con señal alta.',
      'Párrafo sintético con señal moderada.',
      'Párrafo sintético con señal baja.',
      'Figura 1. Diagrama sintético.',
      'Referencias',
      'Smith, A. (2024). Referencia sintética.',
    ].map((phrase) => html.indexOf(phrase));

    expect(html).toContain('aria-selected="true" aria-controls="analysis-review-view"');
    expect(html).toContain('analysis-review-document');
    expect(html).toContain('analysis-review-highlight');
    expect(html).not.toContain('is-highlight-moderate');
    expect(html).not.toContain('is-highlight-high');
    expect(html).toContain('Resaltado 1 de 2');
    expect(html).toContain('Referencia bibliográfica');
    expect(html).toContain('analysis-review-paragraph-action');
    expect(html).not.toContain('analysis-review-drawer');
    expect(html).toContain('Señalados por detector: 5');
    expect(html).toContain('Resaltados para revisión: 2');
    expect(html).toContain('Señalados por detector excluidos de revisión visual: 4');
    expect(html).toContain('Señal local &gt;20.0 %');
    expect(html.match(/<mark class="analysis-review-highlight"/g)).toHaveLength(2);
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]).toBeGreaterThan(positions[index - 1]!);
    }
  })

  it('defaults technical detail to the grouped API presentation while keeping the raw segment view optional', () => {
    const html = renderPanel({ initialView: 'DETAIL' });
    expect(html).toContain('aria-pressed="true">Agrupada');
    expect(html).toContain('aria-pressed="false">Segmentos');
    expect(html).toContain('Detalle técnico agrupado');
    expect(html).toContain('91.0 %');
    expect(html).toContain('49.0 %');
    expect(html).toContain('20.0 %');
    expect(html).toContain('data-display-unit-type="REFERENCE_GROUP"');
    expect(html).toContain('DATOS DE PORTADA');
    expect(html).not.toContain('analysis-heatmap-strip');
  })

  it('uses full-run presentation counts instead of the raw segment page counts', () => {
    const html = renderPanel({ initialView: 'SUMMARY' });
    expect(html).toContain('7 evaluados · 5 señalados por detector');
    expect(html).toContain('2 resaltados · 4 señalados por detector excluidos de revisión visual');
    expect(segmentsQuery().data.items).toHaveLength(1);
  })

  it('compacts consecutive INSUFFICIENT_TEXT paragraphs (>= 2) while leaving single items ungrouped', () => {
    const baseSegment = {
      id: '00000000-0000-4000-8000-000000000011',
      charStart: 0,
      charEnd: 20,
      pageNumber: 1,
      words: 3,
      tokens: 4,
      modelName: 'CANDIDATE_MODEL_V3',
      rawScore: null,
      calibratedScore: null,
      classification: 'INSUFFICIENT_TEXT' as const,
      signalLevel: null,
      confidence: 'INSUFFICIENT' as const,
      text: 'Título corto',
    }
    const items = [
      { ...baseSegment, paragraphIndex: 0, classification: 'LOW_SIGNAL' as const, calibratedScore: 0.12 },
      { ...baseSegment, paragraphIndex: 1 },
      { ...baseSegment, paragraphIndex: 2 },
      { ...baseSegment, paragraphIndex: 3 },
      { ...baseSegment, paragraphIndex: 4, classification: 'MACHINE_SIGNAL' as const, calibratedScore: 0.91 },
      { ...baseSegment, paragraphIndex: 5 },
    ]

    const grouped = groupParagraphSegments(items, true)
    expect(grouped).toHaveLength(4)
    expect(grouped[0].type).toBe('single')
    expect(grouped[1]).toMatchObject({
      type: 'insufficient-group',
      groupKey: '1-3',
      startIndex: 1,
      endIndex: 3,
    })
    expect(grouped[2].type).toBe('single')
    expect(grouped[3].type).toBe('single')
  })
})

