import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  type AnalysisClassification,
  type QuickAnalysisResponse,
} from '../../api/analysis'
import { Icon } from '../../components/Icon'
import {
  getQuickAnalysisOverLimitGuidance,
  isQuickAnalysisShortcut,
  MAX_TEXT_LENGTH,
  runQuickAnalysis,
  splitQuickTextParagraphs,
} from './quick-analysis-utils'
import './QuickAnalysisPage.css'

function countWords(text: string) {
  return text.trim().match(/\S+/gu)?.length ?? 0
}

function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null
  const oneDecimal = Math.round(value * 1000) / 10
  return `${oneDecimal.toLocaleString('es-PE', { maximumFractionDigits: 1 })}%`
}

function statusLabel(status: AnalysisClassification | null) {
  if (status === 'MACHINE_SIGNAL') return 'Señal de IA'
  if (status === 'LOW_SIGNAL') return 'Señal baja'
  return 'No evaluado'
}

function localSignalMessage(status: AnalysisClassification | null, evaluated: boolean) {
  if (!evaluated || status === null || status === 'INSUFFICIENT_TEXT') {
    return 'El evaluador local no pudo evaluar el texto.'
  }
  if (status === 'MACHINE_SIGNAL') return 'El evaluador local reporta una señal de IA.'
  return 'El evaluador local reporta una señal baja.'
}

function ParagraphResult({
  paragraph,
  number,
  paragraphText,
}: {
  paragraph: QuickAnalysisResponse['paragraphs'][number]
  number: number
  paragraphText: string | undefined
}) {
  const insufficient = paragraph.status === 'INSUFFICIENT_TEXT' || paragraph.score === null
  const paragraphScore = insufficient ? null : formatPercent(paragraph.score)
  const reviewStatus = insufficient
    ? 'No evaluado'
    : paragraph.reviewHighlighted
      ? 'Revisión visual sugerida'
      : 'Sin resaltado visual'

  return (
    <article className={`quick-result-paragraph${paragraph.reviewHighlighted ? ' is-highlighted' : ''}${insufficient ? ' is-insufficient' : ''}`}>
      <div className="quick-result-paragraph-main">
        <div className="quick-result-paragraph-heading">
          <span className="quick-paragraph-index">Párrafo {number}</span>
          <span className={`quick-status-pill${insufficient ? ' is-muted' : paragraph.status === 'MACHINE_SIGNAL' ? ' is-signal' : ' is-low'}`}>
            {statusLabel(paragraph.status)}
          </span>
        </div>
        <strong className="quick-paragraph-score">{paragraphScore ?? 'No evaluado'}</strong>
        <span className={`quick-paragraph-review${paragraph.reviewHighlighted ? ' is-highlighted' : ''}`}>
          {reviewStatus}
        </span>
      </div>
      <details className="quick-source-details">
        <summary>Ver texto del párrafo</summary>
        {paragraphText === undefined ? (
          <p className="quick-source-unavailable">No se pudo asociar este resultado con un fragmento local.</p>
        ) : (
          <p className="quick-source-text">{paragraphText}</p>
        )}
      </details>
    </article>
  )
}

export function QuickResultSummary({
  result,
  paragraphTexts,
}: {
  result: QuickAnalysisResponse
  paragraphTexts: string[]
}) {
  const evaluated = result.evaluated && result.score !== null && result.scientificFlag !== null
  const signalMessage = localSignalMessage(result.scientificFlag, evaluated)
  const reviewMessage = !evaluated
    ? 'No evaluado'
    : result.reviewHighlighted
      ? 'Revisión visual sugerida'
      : 'Sin revisión visual sugerida'

  return (
    <section className="quick-result-card" aria-labelledby="quick-result-title" aria-live="polite">
      <div className="quick-result-header">
        <div>
          <p className="quick-eyebrow">Resultado de esta sesión</p>
          <h2 id="quick-result-title">{evaluated ? 'Análisis completado' : 'Texto no evaluado'}</h2>
        </div>
        <span className={`quick-overall-status${evaluated ? ' is-complete' : ' is-unrated'}`}>
          <span className="quick-status-dot" aria-hidden="true" />
          {evaluated ? `${result.scoredParagraphs} evaluado${result.scoredParagraphs === 1 ? '' : 's'}` : 'No evaluado'}
        </span>
      </div>

      <div className={`quick-result-overview${evaluated ? '' : ' is-unrated'}`}>
        <div className="quick-global-score">
          <span className="quick-metric-label">Puntaje global</span>
          <strong>{evaluated ? formatPercent(result.score) : 'No evaluado'}</strong>
          <small>Puntaje del evaluador local</small>
        </div>
        <div className="quick-global-signals">
          <div className="quick-signal-status">
            <span className="quick-metric-label">Señal del evaluador</span>
            <strong>{signalMessage}</strong>
          </div>
          <div className={`quick-review-status${result.reviewHighlighted ? ' is-highlighted' : ''}`}>
            <span className="quick-metric-label">Estado de revisión</span>
            <strong>{reviewMessage}</strong>
          </div>
        </div>
      </div>

      {!evaluated && (
        <p className="quick-insufficient-message">
          No se asignó puntaje. Añade más contenido a los párrafos sin evaluar y vuelve a intentarlo.
        </p>
      )}

      <details className="quick-technical-details">
        <summary>Detalles técnicos del análisis</summary>
        <div className="quick-technical-grid">
          <div><span className="quick-metric-label">Umbral científico</span><strong>{formatPercent(result.scientificThreshold)}</strong></div>
          <div><span className="quick-metric-label">Umbral visual (estricto)</span><strong>&gt; {formatPercent(result.reviewThreshold)}</strong></div>
          <div><span className="quick-metric-label">Modelo usado</span><strong>{result.model.displayName}</strong></div>
          <div><span className="quick-metric-label">Versión</span><strong>{result.model.version}</strong></div>
          <div><span className="quick-metric-label">Idioma procesado</span><strong>{result.languageCode.toUpperCase()}</strong></div>
          <div><span className="quick-metric-label">Tiempo de respuesta</span><strong>{Math.round(result.latencyMs)} ms</strong></div>
        </div>
      </details>

      {result.paragraphs.length > 0 && (
        <div className="quick-paragraph-results">
          <div className="quick-paragraph-results-heading">
            <h3>Resultado por párrafo</h3>
            <span>{result.scoredParagraphs} evaluado{result.scoredParagraphs === 1 ? '' : 's'} · {result.insufficientParagraphs} sin evaluar</span>
          </div>
          <div className="quick-paragraph-results-list">
            {result.paragraphs.map((paragraph) => (
              <ParagraphResult
                key={paragraph.index}
                paragraph={paragraph}
                number={paragraph.index + 1}
                paragraphText={paragraphTexts[paragraph.index]}
              />
            ))}
          </div>
        </div>
      )}

      <p className="quick-disclaimer">Resultado orientativo. Revisa el contenido y su contexto; ninguna señal determina por sí sola quién escribió el texto.</p>
    </section>
  )
}

export function QuickStatusPanel({
  status,
  message,
  retryable = false,
  onRetry,
}: {
  status: 'idle' | 'loading' | 'error'
  message?: string
  retryable?: boolean
  onRetry?: () => void
}) {
  if (status === 'loading') {
    return (
      <div className="quick-feedback-card quick-loading" role="status" aria-live="polite">
        <span className="quick-spinner" aria-hidden="true" />
        <div><strong>Analizando el texto…</strong><span>La solicitud se procesa sin crear historial.</span></div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <section className="quick-feedback-card quick-error-state" aria-labelledby="quick-error-title" role="alert">
        <h2 id="quick-error-title">No se pudo completar el análisis</h2>
        <p>{message}</p>
        {retryable && onRetry && (
          <button className="quick-retry-button" type="button" onClick={onRetry}>
            <Icon name="refresh" size={15} /> Reintentar análisis
          </button>
        )}
      </section>
    )
  }

  return (
    <section className="quick-feedback-card quick-empty-result" aria-label="Resultado pendiente">
      <span className="quick-empty-mark" aria-hidden="true"><Icon name="spark" size={20} /></span>
      <h2>Tu resultado aparecerá aquí</h2>
      <p>El puntaje y las señales por párrafo se mostrarán cuando completes el análisis.</p>
    </section>
  )
}


export function QuickAnalysisPage() {
  const [text, setText] = useState('')
  const [result, setResult] = useState<QuickAnalysisResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [canRetry, setCanRetry] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const paragraphTexts = useMemo(() => splitQuickTextParagraphs(text), [text])

  const wordCount = countWords(text)
  const isOverLimit = text.length > MAX_TEXT_LENGTH

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (isSubmitting || !text.trim() || isOverLimit) return

    setIsSubmitting(true)
    setError(null)
    setCanRetry(false)
    setResult(null)
    const response = await runQuickAnalysis(text)
    setResult(response.result)
    setError(response.error)
    setCanRetry(response.retryable)
    setIsSubmitting(false)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isQuickAnalysisShortcut(event)) {
      event.preventDefault()
      void submit()
    }
  }

  function clearText() {
    setText('')
    setResult(null)
    setError(null)
    setCanRetry(false)
  }

  const resultState = isSubmitting ? 'loading' : error ? 'error' : result ? null : 'idle'

  return (
    <div className="quick-page">
      <header className="quick-page-heading">
        <div className="quick-title-icon" aria-hidden="true"><Icon name="spark" size={20} /></div>
        <div>
          <p className="quick-eyebrow">Análisis rápido</p>
          <h1>Analiza un texto</h1>
          <p className="quick-page-intro">Pega un texto para revisar su puntaje local y las señales de cada párrafo. El modelo disponible se elige automáticamente.</p>
        </div>
      </header>

      <div className="quick-analysis-layout">
        <form className="quick-input-card" onSubmit={submit}>
          <label className="quick-input-label" htmlFor="quick-analysis-text">Texto a analizar</label>
          <textarea
            id="quick-analysis-text"
            value={text}
            onChange={(event) => {
              setText(event.currentTarget.value)
              setResult(null)
              setError(null)
              setCanRetry(false)
            }}
            onKeyDown={handleKeyDown}
            placeholder="Pega aquí uno o varios párrafos…"
            aria-describedby="quick-input-help quick-input-count"
            disabled={isSubmitting}
          />
          <div className="quick-input-footer">
            <p id="quick-input-help">El texto solo se envía para esta consulta; no se guarda en el historial.</p>
            <span id="quick-input-count" className={isOverLimit ? 'is-over-limit' : ''}>
              {wordCount.toLocaleString('es-PE')} palabras · {text.length.toLocaleString('es-PE')} / {MAX_TEXT_LENGTH.toLocaleString('es-PE')} caracteres
            </span>
          </div>
          {isOverLimit && (
            <p className="quick-input-error" role="alert">{getQuickAnalysisOverLimitGuidance(text.length)}</p>
          )}
          <div className="quick-form-actions">
            <button className="quick-submit-button" type="submit" disabled={isSubmitting || !text.trim() || isOverLimit}>
              {isSubmitting ? <><span className="quick-spinner" aria-hidden="true" /> Analizando…</> : <><Icon name="spark" size={16} /> Analizar texto</>}
            </button>
            {text.length > 0 && <button className="quick-clear-button" type="button" onClick={clearText} disabled={isSubmitting}>Limpiar</button>}
            <span className="quick-shortcut-hint">Atajo: Ctrl/Cmd + Enter</span>
          </div>
          <p className="quick-privacy-note"><Icon name="shield-check" size={14} /> No se crea documento, reporte ni entrada de historial.</p>
        </form>

        <div className="quick-result-column">
          {result ? (
            <QuickResultSummary result={result} paragraphTexts={paragraphTexts} />
          ) : (
            <QuickStatusPanel
              status={resultState ?? 'idle'}
              message={error ?? undefined}
              retryable={canRetry}
              onRetry={() => void submit()}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export default QuickAnalysisPage
