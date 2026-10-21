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
} from './QuickAnalysisPage'
import {
  getQuickAnalysisErrorMessage,
  getQuickAnalysisOverLimitGuidance,
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
      <QuickResultSummary result={insufficientResponse} paragraphTexts={['Un fragmento breve.']} />,
    )

    expect(markup).toContain('Texto no evaluado')
    expect(markup).toContain('No se asignó puntaje.')
    expect(markup).toContain('El evaluador local no pudo evaluar el texto.')
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

  it('recognizes Ctrl+Enter and Cmd+Enter without triggering on plain Enter', () => {
    expect(isQuickAnalysisShortcut({ key: 'Enter', ctrlKey: true, metaKey: false })).toBe(true)
    expect(isQuickAnalysisShortcut({ key: 'Enter', ctrlKey: false, metaKey: true })).toBe(true)
    expect(isQuickAnalysisShortcut({ key: 'Enter', ctrlKey: false, metaKey: false })).toBe(false)
    expect(isQuickAnalysisShortcut({ key: 'Escape', ctrlKey: true, metaKey: false })).toBe(false)
  })
})
