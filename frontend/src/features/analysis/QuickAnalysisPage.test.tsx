import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  analyzeQuickText,
  quickAnalysisResponseSchema,
  type QuickAnalysisResponse,
} from '../../api/analysis'
import { ApiRequestError } from '../../api/client'
import {
  QuickResultSummary,
  QuickStatusPanel,
  isLanguageCalibrationAnalyzer,
  isQuickAnalyzerAvailable,
} from './QuickAnalysisPage'
import {
  copyPlainText,
  filterQuickResultParagraphs,
  formatQuickParagraphCopy,
  formatQuickResultCopy,
  getQuickAnalysisErrorMessage,
  getQuickAnalysisOverLimitGuidance,
  isQuickResultStale,
  isQuickAnalysisRetryable,
  isQuickAnalysisShortcut,
  runQuickAnalysis,
  splitQuickTextParagraphs,
} from './quick-analysis-utils'

const syntheticResponse: QuickAnalysisResponse = {
  evaluated: true,
  score: 0.963,
  scientificFlag: 'MACHINE_SIGNAL',
  reviewHighlighted: true,
  scoredParagraphs: 2,
  insufficientParagraphs: 1,
  scientificThreshold: 0.5,
  reviewThreshold: 0.2,
  model: { id: 'V3_ONLY', displayName: 'Modelo local sintético', version: 'test-1' },
  languageCode: 'es',
  latencyMs: 12,
  paragraphs: [
    { index: 0, status: 'LOW_SIGNAL', score: 0.2, scientificFlag: false, reviewHighlighted: false },
    { index: 1, status: 'MACHINE_SIGNAL', score: 0.2001, scientificFlag: true, reviewHighlighted: true },
    { index: 2, status: 'INSUFFICIENT_TEXT', score: null, scientificFlag: null, reviewHighlighted: false },
  ],
}

const insufficientResponse: QuickAnalysisResponse = {
  ...syntheticResponse,
  evaluated: false,
  score: null,
  scientificFlag: null,
  reviewHighlighted: false,
  scoredParagraphs: 0,
  insufficientParagraphs: 1,
  paragraphs: [
    { index: 0, status: 'INSUFFICIENT_TEXT', score: null, scientificFlag: null, reviewHighlighted: false },
  ],
}

afterEach(() => vi.unstubAllGlobals())

const summaryActions = {
  stale: false,
  filter: 'all' as const,
  onFilterChange: () => undefined,
  onCopyAll: () => undefined,
  onCopyParagraph: () => undefined,
  onReanalyze: () => undefined,
}

describe('quick text analysis', () => {
  it('accepts the aggregate score and detector status from the backend contract', () => {
    const parsed = quickAnalysisResponseSchema.parse(syntheticResponse)
    expect(parsed).toMatchObject({
      score: 0.963,
      scientificFlag: 'MACHINE_SIGNAL',
      reviewHighlighted: true,
    })
  })

  it('renders the aggregate score as primary and honors the backend review flags at 0.20 and 0.2001', () => {
    const markup = renderToStaticMarkup(
      <QuickResultSummary
        result={syntheticResponse}
        paragraphTexts={['Primer texto sintético.', 'Segundo texto sintético.', 'Fragmento corto.']}
        {...summaryActions}
      />,
    )

    expect(markup).toContain('Puntaje global')
    expect(markup).toMatch(/Párrafo 1[\s\S]*?Sin resaltado visual/)
    expect(markup).toMatch(/Párrafo 2[\s\S]*?Revisión visual sugerida/)
    expect(markup).toContain('quick-result-paragraph is-highlighted')
    expect(markup).toContain('Primer texto sintético.')
    expect(markup).toContain('Segundo texto sintético.')
    expect(markup).not.toMatch(/<details class="quick-technical-details" open/)
    expect(markup).not.toMatch(/<details class="quick-source-details" open/)
    expect(markup).not.toContain('quick-summary-item')
  })

  it('shows null and insufficient aggregate results as unevaluated without turning them into zero', () => {
    const markup = renderToStaticMarkup(
      <QuickResultSummary result={insufficientResponse} paragraphTexts={['Un fragmento breve.']} {...summaryActions} />,
    )

    expect(markup).toContain('Texto no evaluado')
    expect(markup).toContain('No se asignó puntaje.')
    expect(markup).toContain('El evaluador local no pudo asignar una señal.')
    expect(markup).toContain('quick-result-overview is-unrated')
    expect(markup).not.toContain('NaN')
    expect(markup).not.toContain('undefined')
  })

  it('shows a loading status while a synthetic request is pending', () => {
    const markup = renderToStaticMarkup(<QuickStatusPanel status="loading" />)
    expect(markup).toContain('role="status"')
    expect(markup).toContain('Analizando el texto…')
    expect(markup).toContain('sin crear historial')
  })

  it('returns a synthetic successful result and offers a retry after retryable errors', async () => {
    const request = vi.fn().mockResolvedValue(syntheticResponse)
    const success = await runQuickAnalysis('Texto sintético.', request)
    expect(success.result?.score).toBe(0.963)
    expect(success.error).toBeNull()

    const serviceError = new ApiRequestError('Servicio no disponible', 503, 'SERVICE_UNAVAILABLE')
    const failingRequest = vi.fn().mockRejectedValue(serviceError)
    const failure = await runQuickAnalysis('Texto sintético.', failingRequest)
    expect(failure.error).toContain('no está disponible')
    expect(failure.retryable).toBe(true)

    const markup = renderToStaticMarkup(
      <QuickStatusPanel
        status="error"
        message={failure.error ?? undefined}
        retryable={failure.retryable}
        onRetry={() => undefined}
      />,
    )
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Reintentar análisis')
  })

  it('gives an exact over-limit correction and only retries transport or service failures', () => {
    expect(getQuickAnalysisOverLimitGuidance(20_000)).toBeNull()
    expect(getQuickAnalysisOverLimitGuidance(20_001)).toContain('Elimina 1 carácter')
    expect(getQuickAnalysisOverLimitGuidance(20_003)).toContain('Elimina 3 caracteres')
    expect(getQuickAnalysisErrorMessage(new ApiRequestError('too long', 413, 'TEXT_TOO_LONG'))).toContain('20 000 caracteres')
    expect(isQuickAnalysisRetryable(new ApiRequestError('server', 503))).toBe(true)
    expect(isQuickAnalysisRetryable(new ApiRequestError('invalid', 400))).toBe(false)
    expect(isQuickAnalysisRetryable(new Error('network failure'))).toBe(true)
  })

  it('keeps Unicode and multiline source local and sends only the original text field', async () => {
    const text = 'La investigación lingüística conserva acentos y emojis 🦜.\nque siguen en la misma idea.\n\nSegundo párrafo: ¿qué cambia?'
    expect(splitQuickTextParagraphs(text)).toEqual([
      'La investigación lingüística conserva acentos y emojis 🦜.',
      'que siguen en la misma idea.',
      'Segundo párrafo: ¿qué cambia?',
    ])

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(syntheticResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await analyzeQuickText(text)
    expect(result.score).toBe(0.963)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, request] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/analysis/quick')
    expect(request).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ text }),
    })
    expect(JSON.parse(request.body as string)).toEqual({ text })
  })

  it('forwards an AbortSignal to the quick-analysis request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(syntheticResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await analyzeQuickText('Texto sintético.', {}, controller.signal)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: controller.signal })
  })

  it('recognizes Ctrl+Enter and Cmd+Enter without triggering on plain Enter', () => {
    expect(isQuickAnalysisShortcut({ key: 'Enter', ctrlKey: true, metaKey: false })).toBe(true)
    expect(isQuickAnalysisShortcut({ key: 'Enter', ctrlKey: false, metaKey: true })).toBe(true)
    expect(isQuickAnalysisShortcut({ key: 'Enter', ctrlKey: false, metaKey: false })).toBe(false)
    expect(isQuickAnalysisShortcut({ key: 'Escape', ctrlKey: true, metaKey: false })).toBe(false)
  })

  it('keeps the exact backend review flag boundary and filters using returned fields', () => {
    expect(filterQuickResultParagraphs(syntheticResponse.paragraphs, 'review').map(({ index }) => index)).toEqual([1])
    expect(filterQuickResultParagraphs(syntheticResponse.paragraphs, 'flagged').map(({ index }) => index)).toEqual([1])
    expect(filterQuickResultParagraphs(syntheticResponse.paragraphs, 'unevaluated').map(({ index }) => index)).toEqual([2])
    expect(filterQuickResultParagraphs(syntheticResponse.paragraphs, 'all')).toHaveLength(3)
    expect(syntheticResponse.paragraphs[0].reviewHighlighted).toBe(false)
    expect(syntheticResponse.paragraphs[1].reviewHighlighted).toBe(true)
  })

  it('copies the global score and every paragraph number, score, and snapshot text without internal identifiers', () => {
    const copied = formatQuickResultCopy(syntheticResponse, ['Texto P1.', 'Texto P2.', 'Texto P3.'], {
      analyzer: 'F006.1.1 · Experimental',
      profile: 'Equilibrado',
      mode: 'STRICT_PARAGRAPH',
      language: 'ES',
    })
    expect(copied).toContain('TURNITING — Análisis rápido')
    expect(copied).toMatch(/Señal global estimada: 96[,.]3%/)
    expect(copied).toContain('Párrafos evaluados: 2 de 3')
    expect(copied).toContain('Párrafo 1 — 20%\nTexto P1.')
    expect(copied).toContain('Párrafo 2 — 20%\nTexto P2.')
    expect(copied).toContain('Párrafo 3 — No evaluado\nTexto P3.')
    expect(copied).toContain('Analizador: F006.1.1 · Experimental')
    expect(copied).toContain('Perfil: Equilibrado')
    expect(copied).toContain('Modo: STRICT_PARAGRAPH')
    expect(copied).toContain('Idioma: ES')
    expect(copied).not.toContain(syntheticResponse.model.id)
    expect(copied).not.toContain('test-1')
    expect(formatQuickParagraphCopy(syntheticResponse.paragraphs[2], 'Texto P3.')).toBe('Párrafo 3 — No evaluado\nTexto P3.')
  })

  it('uses the original analysis snapshot after the editable text changes', () => {
    const snapshot = 'Texto original 🦜.'
    expect(isQuickResultStale(snapshot, snapshot)).toBe(false)
    expect(isQuickResultStale('Texto editado 🦜.', snapshot)).toBe(true)
  })

  it('uses Clipboard API first and falls back when that API rejects', async () => {
    const clipboardWrite = vi.fn().mockResolvedValue(undefined)
    expect(await copyPlainText('Texto sintético.', clipboardWrite, () => false)).toBe('clipboard')
    expect(clipboardWrite).toHaveBeenCalledWith('Texto sintético.')

    const fallback = vi.fn().mockReturnValue(true)
    expect(await copyPlainText('Texto sintético.', vi.fn().mockRejectedValue(new Error('denied')), fallback)).toBe('fallback')
    expect(fallback).toHaveBeenCalledWith('Texto sintético.')
    await expect(copyPlainText('Texto sintético.', vi.fn().mockRejectedValue(new Error('denied')), () => false))
      .rejects.toThrow('No se pudo copiar')
  })

  it('only asks for a calibration language on F006.1 and F006.1.1', () => {
    expect(isLanguageCalibrationAnalyzer('F006_1_ONLY')).toBe(true)
    expect(isLanguageCalibrationAnalyzer('F006_1_1_ONLY')).toBe(true)
    expect(isLanguageCalibrationAnalyzer('V3_ONLY')).toBe(false)
  })

  it('requires a registered, available and servable model for each selectable analyzer', () => {
    const models = [
      { name: 'CANDIDATE_MODEL_V3', availability: 'READY' as const, servable: true },
      { name: 'EXPERIMENTAL_F006_1_MODEL', availability: 'READY' as const, servable: true },
      { name: 'EXPERIMENTAL_F006_1_1_MODEL', availability: 'UNAVAILABLE' as const, servable: false },
      { name: 'ENSEMBLE_V2_V3', availability: 'COMPOSITE_AVAILABLE' as const, servable: true },
      { name: 'CANDIDATE_MODEL_V2', availability: 'READY' as const, servable: true },
    ]
    expect(isQuickAnalyzerAvailable('V3_ONLY', models)).toBe(true)
    expect(isQuickAnalyzerAvailable('F006_1_ONLY', models)).toBe(true)
    expect(isQuickAnalyzerAvailable('F006_1_1_ONLY', models)).toBe(false)
    expect(isQuickAnalyzerAvailable('ENSEMBLE', models)).toBe(true)
    expect(isQuickAnalyzerAvailable('V3_ONLY', undefined)).toBe(false)
  })
})
