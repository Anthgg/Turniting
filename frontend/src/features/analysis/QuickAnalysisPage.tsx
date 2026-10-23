import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ANALYZERS,
  PARAGRAPH_MODES,
  THRESHOLD_PROFILES,
  analysisQueryKeys,
  analyzeQuickText,
  listAnalyzerModels,
  type AnalysisClassification,
  type AnalyzerModel,
  type AnalyzerName,
  type LanguageCode,
  type ParagraphModeName,
  type QuickAnalysisResponse,
  type ThresholdProfileName,
} from '../../api/analysis'
import { Icon } from '../../components/Icon'
import { CustomSelect } from '../../components/CustomSelect'
import type { CustomSelectOption } from '../../components/custom-select-utils'
import { TurnitingMascot, type MascotState } from '../../components/TurnitingMascot'
import {
  ANALYZER_LABEL,
  DEFAULT_PARAGRAPH_MODE,
  isAnalyzerUsable,
  PROFILE_LABEL,
} from './analysis-utils'
import {
  copyPlainText,
  filterQuickResultParagraphs,
  formatQuickParagraphCopy,
  formatQuickResultCopy,
  getSelectableThresholdProfiles,
  getQuickAnalysisOverLimitGuidance,
  reconcileThresholdProfile,
  type QuickAnalysisErrorMascotState,
  isQuickResultStale,
  isQuickAnalysisShortcut,
  MAX_TEXT_LENGTH,
  type QuickResultFilter,
  runQuickAnalysis,
  splitQuickTextParagraphs,
} from './quick-analysis-utils'
import './QuickAnalysisPage.css'

const MODEL_FOR_ANALYZER: Record<AnalyzerName, string> = {
  V3_ONLY: 'CANDIDATE_MODEL_V3',
  V2_ONLY: 'CANDIDATE_MODEL_V2',
  ENSEMBLE: 'ENSEMBLE_V2_V3',
  F006_1_ONLY: 'EXPERIMENTAL_F006_1_MODEL',
  F006_1_1_ONLY: 'EXPERIMENTAL_F006_1_1_MODEL',
}

const ANALYZER_FOR_MODEL: Record<string, AnalyzerName> = {
  CANDIDATE_MODEL_V2: 'V2_ONLY',
  CANDIDATE_MODEL_V3: 'V3_ONLY',
  ENSEMBLE_V2_V3: 'ENSEMBLE',
  EXPERIMENTAL_F006_1_MODEL: 'F006_1_ONLY',
  EXPERIMENTAL_F006_1_1_MODEL: 'F006_1_1_ONLY',
}

const QUICK_RESULT_FILTER_OPTIONS: CustomSelectOption[] = [
  { value: 'all', label: 'Todos' },
  { value: 'review', label: 'Para revisión (>20%)' },
  { value: 'flagged', label: 'Señalados por detector' },
  { value: 'unevaluated', label: 'No evaluados' },
]

export function isQuickAnalyzerAvailable(
  analyzer: AnalyzerName,
  models: Array<Pick<AnalyzerModel, 'name' | 'availability' | 'servable'>> | undefined,
) {
  const requiredModels = analyzer === 'ENSEMBLE'
    ? [MODEL_FOR_ANALYZER[analyzer], 'CANDIDATE_MODEL_V2', 'CANDIDATE_MODEL_V3']
    : [MODEL_FOR_ANALYZER[analyzer]]
  return requiredModels.every((name) => {
    const model = models?.find((item) => item.name === name)
    return Boolean(model?.servable && isAnalyzerUsable(model.availability))
  })
}

export function isLanguageCalibrationAnalyzer(analyzer: AnalyzerName) {
  return analyzer === 'F006_1_ONLY' || analyzer === 'F006_1_1_ONLY'
}

function countWords(text: string) {
  return text.trim().match(/\S+/gu)?.length ?? 0
}

function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null
  const oneDecimal = Math.round(value * 1000) / 10
  return `${oneDecimal.toLocaleString('es-PE', { maximumFractionDigits: 1 })}%`
}

function statusLabel(status: AnalysisClassification | null) {
  if (status === 'MACHINE_SIGNAL') return 'Señalada por detector'
  if (status === 'LOW_SIGNAL') return 'Señal baja'
  return 'No evaluado'
}

function localSignalMessage(status: AnalysisClassification | null, evaluated: boolean) {
  if (!evaluated || status === null || status === 'INSUFFICIENT_TEXT') {
    return 'El evaluador local no pudo asignar una señal.'
  }
  if (status === 'MACHINE_SIGNAL') return 'El detector marcó una señal en este texto.'
  return 'El detector no marcó una señal alta.'
}

function ParagraphResult({
  paragraph,
  number,
  paragraphText,
  onCopy,
}: {
  paragraph: QuickAnalysisResponse['paragraphs'][number]
  number: number
  paragraphText: string | undefined
  onCopy: () => void
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
      <button className="quick-copy-paragraph" type="button" onClick={onCopy} aria-label={`Copiar párrafo ${number} y su puntaje`}>
        <Icon name="file" size={14} /> Copiar párrafo
      </button>
    </article>
  )
}

export function QuickResultSummary({
  result,
  paragraphTexts,
  analyzer,
  profile,
  mode,
  stale,
  filter,
  onFilterChange,
  onCopyAll,
  onCopyParagraph,
  onReanalyze,
  mascotState,
}: {
  result: QuickAnalysisResponse
  paragraphTexts: string[]
  analyzer?: AnalyzerName
  profile?: ThresholdProfileName
  mode?: ParagraphModeName
  stale: boolean
  filter: QuickResultFilter
  onFilterChange: (filter: QuickResultFilter) => void
  onCopyAll: () => void
  onCopyParagraph: (paragraph: QuickAnalysisResponse['paragraphs'][number]) => void
  onReanalyze: () => void
  mascotState?: MascotState
}) {
  const evaluated = result.evaluated && result.score !== null && result.scientificFlag !== null
  const appliedAnalyzer = result.analyzer ?? analyzer ?? 'V3_ONLY'
  const appliedProfile = result.thresholdProfile ?? profile ?? 'BALANCED'
  const appliedProfileLabel = isLanguageCalibrationAnalyzer(appliedAnalyzer)
    ? 'Umbral fijo del modelo según idioma'
    : PROFILE_LABEL[appliedProfile]
  const appliedMode = result.paragraphMode ?? mode ?? DEFAULT_PARAGRAPH_MODE
  const signalMessage = localSignalMessage(result.scientificFlag, evaluated)
  const reviewMessage = !evaluated
    ? 'No evaluado'
    : result.reviewHighlighted
      ? 'Revisión visual sugerida'
      : 'Sin revisión visual sugerida'
  const flaggedCount = result.paragraphs.filter((paragraph) => paragraph.scientificFlag === true).length
  const reviewCount = result.paragraphs.filter((paragraph) => paragraph.reviewHighlighted).length
  const visibleParagraphs = filterQuickResultParagraphs(result.paragraphs, filter)

  return (
    <section className="quick-result-card" aria-labelledby="quick-result-title">
      <div className="quick-result-header">
        <div className="quick-result-title-group">
          <TurnitingMascot state={mascotState ?? (evaluated ? 'result-reveal' : 'warning')} size="compact" />
          <div>
            <p className="quick-eyebrow">Resultado de esta sesión</p>
            <h2 id="quick-result-title" aria-live="polite" aria-atomic="true">{evaluated ? 'Análisis completado' : 'Texto no evaluado'}</h2>
          </div>
        </div>
        <span className={`quick-overall-status${evaluated ? ' is-complete' : ' is-unrated'}`}>
          <span className="quick-status-dot" aria-hidden="true" />
          {evaluated ? `${result.scoredParagraphs} evaluado${result.scoredParagraphs === 1 ? '' : 's'}` : 'No evaluado'}
        </span>
      </div>

      <div className="quick-copy-actions">
        <button className="quick-copy-all" type="button" onClick={onCopyAll}><Icon name="file" size={15} /> Copiar todo</button>
        <span>Incluye el puntaje global y el texto asociado a cada párrafo.</span>
      </div>

      {stale && (
        <div className="quick-stale-notice" role="status">
          <span>Texto modificado desde el último análisis. El resultado conserva el texto analizado.</span>
          <button type="button" onClick={onReanalyze}>Reanalizar texto</button>
        </div>
      )}

      <div className={`quick-result-overview${evaluated ? '' : ' is-unrated'}`}>
        <div className="quick-global-score">
          <span className="quick-metric-label">Puntaje global</span>
          <strong>{evaluated ? formatPercent(result.score) : 'No evaluado'}</strong>
          <small>Puntaje del evaluador local</small>
        </div>
        <div className="quick-global-signals">
          <div className="quick-signal-status">
            <span className="quick-metric-label">Señal del detector</span>
            <strong>{signalMessage}</strong>
          </div>
          <div className={`quick-review-status${result.reviewHighlighted ? ' is-highlighted' : ''}`}>
            <span className="quick-metric-label">Estado de revisión</span>
            <strong>{reviewMessage}</strong>
          </div>
        </div>
      </div>

      <div className="quick-result-counts" aria-label="Conteo de párrafos">
        <span><strong>{result.scoredParagraphs}</strong> evaluados</span>
        <span><strong>{flaggedCount}</strong> señalados por detector</span>
        <span><strong>{reviewCount}</strong> para revisión (&gt;20%)</span>
        <span><strong>{result.insufficientParagraphs}</strong> no evaluados</span>
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
          <div><span className="quick-metric-label">Analizador</span><strong>{appliedAnalyzer === 'ENSEMBLE' ? 'ENSEMBLE_V2_V3 · V2 + V3' : ANALYZER_LABEL[appliedAnalyzer]}</strong></div>
          <div><span className="quick-metric-label">Perfil</span><strong>{appliedProfileLabel}</strong></div>
          <div><span className="quick-metric-label">Modo de párrafo</span><strong>{appliedMode === 'STRICT_PARAGRAPH' ? 'Solo el párrafo' : 'Con contexto breve'}</strong></div>
          <div><span className="quick-metric-label">Modelo usado</span><strong>{result.model.displayName}</strong></div>
          <div><span className="quick-metric-label">Versión</span><strong>{result.model.version}</strong></div>
          <div><span className="quick-metric-label">Idioma procesado</span><strong>{result.languageCode.toUpperCase()}</strong></div>
          <div><span className="quick-metric-label">Tiempo de respuesta</span><strong>{Math.round(result.latencyMs)} ms</strong></div>
        </div>
      </details>

      {result.paragraphs.length > 0 && (
        <div className="quick-paragraph-results">
          <div className="quick-paragraph-results-heading">
            <div>
              <h3>Resultado por párrafo</h3>
              <span>{visibleParagraphs.length} de {result.paragraphs.length} párrafos</span>
            </div>
            <div className="quick-filter-field">
              <span>Mostrar</span>
              <CustomSelect
                id="quick-result-filter"
                label="Mostrar resultados"
                value={filter}
                options={QUICK_RESULT_FILTER_OPTIONS}
                onChange={(next) => onFilterChange(next as QuickResultFilter)}
              />
            </div>
          </div>
          <div className="quick-paragraph-results-list">
            {visibleParagraphs.map((paragraph) => (
              <ParagraphResult
                key={paragraph.index}
                paragraph={paragraph}
                number={paragraph.index + 1}
                paragraphText={paragraphTexts[paragraph.index]}
                onCopy={() => onCopyParagraph(paragraph)}
              />
            ))}
          </div>
          {visibleParagraphs.length === 0 && <p className="quick-filter-empty">No hay párrafos que coincidan con este filtro.</p>}
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
  mascotState,
}: {
  status: 'idle' | 'loading' | 'error'
  message?: string
  retryable?: boolean
  onRetry?: () => void
  mascotState?: MascotState
}) {
  if (status === 'loading') {
    const loadingTitle = mascotState === 'stand-up'
      ? 'Turni se prepara…'
      : mascotState === 'reading'
        ? 'Leyendo párrafos…'
        : 'Analizando señales…'

    return (
      <div className="quick-feedback-card quick-loading" role="status" aria-live="polite">
        <TurnitingMascot state={mascotState ?? 'analyzing'} size="standard" />
        <div className="quick-feedback-copy">
          <p className="quick-eyebrow">Analizador rápido</p>
          <h2>{loadingTitle}</h2>
          <p>La solicitud sigue en curso; la animación no representa un porcentaje de avance.</p>
        </div>
      </div>
    )
  }

  if (status === 'error') {
    const state = mascotState ?? 'error'
    const title = state === 'network-error'
      ? 'No hay conexión con el servicio'
      : state === 'warning'
        ? 'El servicio necesita un momento'
        : 'No se pudo completar el análisis'

    return (
      <section className="quick-feedback-card quick-error-state" aria-labelledby="quick-error-title" role="alert">
        <TurnitingMascot state={state} size="standard" />
        <div className="quick-feedback-copy">
          <p className="quick-eyebrow">Estado del servicio</p>
          <h2 id="quick-error-title">{title}</h2>
          <p>{message}</p>
          {retryable && onRetry && (
            <button className="quick-retry-button" type="button" onClick={onRetry}>
              <Icon name="refresh" size={15} /> Reintentar análisis
            </button>
          )}
        </div>
      </section>
    )
  }

  const state = mascotState ?? 'idle'
  const isReady = state === 'ready'
  const isEmpty = state === 'empty'
  const wasCleared = state === 'clear'

  return (
    <section className="quick-feedback-card quick-empty-result" aria-label="Resultado pendiente">
      <TurnitingMascot state={state} size="standard" />
      <div className="quick-feedback-copy">
        <p className="quick-eyebrow">{isReady ? 'Entrada preparada' : 'Turniting'}</p>
        <h2>{isReady ? 'Texto listo para analizar' : isEmpty ? 'Agrega texto para empezar' : wasCleared ? 'Espacio listo para un nuevo texto' : 'Tu resultado aparecerá aquí'}</h2>
        <p>{isReady
          ? 'Elige el idioma cuando aplique, el perfil, el modo y el analizador; después inicia el análisis.'
          : isEmpty
            ? 'El contenido está vacío. Pega un texto para que Turniting pueda revisarlo.'
            : wasCleared
              ? 'El texto y el resultado se quitaron de esta sesión.'
              : 'El puntaje y las señales por párrafo aparecerán cuando completes el análisis.'}</p>
      </div>
    </section>
  )
}

type QuickAnalysisSnapshot = {
  result: QuickAnalysisResponse
  text: string
  paragraphTexts: string[]
  analyzer: AnalyzerName
  profile: ThresholdProfileName
  mode: ParagraphModeName
  languageCode: LanguageCode
}


export function QuickAnalysisPage() {
  const [text, setText] = useState('')
  const [snapshot, setSnapshot] = useState<QuickAnalysisSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [canRetry, setCanRetry] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [loadingMascotState, setLoadingMascotState] = useState<MascotState>('stand-up')
  const [errorMascotState, setErrorMascotState] = useState<QuickAnalysisErrorMascotState>('error')
  const [mascotCue, setMascotCue] = useState<MascotState | null>(null)
  const [filter, setFilter] = useState<QuickResultFilter>('all')
  const [copyFeedback, setCopyFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const requestPendingRef = useRef(false)
  const requestIdRef = useRef(0)
  const abortControllerRef = useRef<AbortController | null>(null)
  const mascotCueTimeoutRef = useRef<number | null>(null)
  const models = useQuery({
    queryKey: analysisQueryKeys.models(),
    queryFn: listAnalyzerModels,
    retry: 1,
  })
  const [analyzerTouched, setAnalyzerTouched] = useState(false)
  const [analyzer, setAnalyzer] = useState<AnalyzerName>('V3_ONLY')
  const [profile, setProfile] = useState<ThresholdProfileName>('BALANCED')
  const [mode, setMode] = useState<ParagraphModeName>(DEFAULT_PARAGRAPH_MODE)
  const [languageCode, setLanguageCode] = useState<LanguageCode>('other')
  const wordCount = countWords(text)
  const isOverLimit = text.length > MAX_TEXT_LENGTH
  const result = snapshot?.result ?? null
  const preferredAnalyzer = models.data?.resolvedLocalPreferredAnalyzer
  const preferredMode = preferredAnalyzer ? ANALYZER_FOR_MODEL[preferredAnalyzer] : undefined
  const defaultAnalyzer = models.data
    ? [preferredMode, ...ANALYZERS].find((candidate): candidate is AnalyzerName =>
        Boolean(candidate && isQuickAnalyzerAvailable(candidate, models.data?.items)))
    : undefined
  const selectedAnalyzer = analyzerTouched ? analyzer : defaultAnalyzer ?? analyzer

  const analyzerUsable = isQuickAnalyzerAvailable(selectedAnalyzer, models.data?.items)
  const f0061 = models.data?.items.find((item) => item.name === 'EXPERIMENTAL_F006_1_MODEL')
  const f00611 = models.data?.items.find((item) => item.name === 'EXPERIMENTAL_F006_1_1_MODEL')
  const f0061Usable = Boolean(f0061?.servable && isAnalyzerUsable(f0061.availability))
  const f00611Usable = Boolean(f00611?.servable && isAnalyzerUsable(f00611.availability))
  const selectedAnalyzerModel = models.data?.items.find((item) => item.name === MODEL_FOR_ANALYZER[selectedAnalyzer])
  const supportedProfiles = getSelectableThresholdProfiles(THRESHOLD_PROFILES, selectedAnalyzerModel?.thresholdProfiles)
  const analyzerOptions: CustomSelectOption[] = [
    ...ANALYZERS.filter((item) => item !== 'F006_1_ONLY' && item !== 'F006_1_1_ONLY').map((item) => {
      const usable = isQuickAnalyzerAvailable(item, models.data?.items)
      const label = item === 'ENSEMBLE' ? 'ENSEMBLE_V2_V3 · V2 + V3' : ANALYZER_LABEL[item]
      return { value: item, label: usable ? label : `${label} · No disponible`, disabled: !usable }
    }),
    ...(f0061 ? [{ value: 'F006_1_ONLY', label: `F006.1 · Experimental${f0061Usable ? '' : ' · No disponible localmente'}`, disabled: !f0061Usable }] : []),
    ...(f00611 ? [{ value: 'F006_1_1_ONLY', label: `F006.1.1 · Experimental${f00611Usable ? '' : ' · No disponible localmente'}`, disabled: !f00611Usable }] : []),
  ]
  const profileOptions: CustomSelectOption[] = THRESHOLD_PROFILES.map((item) => ({
    value: item,
    label: PROFILE_LABEL[item],
    disabled: !supportedProfiles.includes(item),
  }))
  const displayedProfileOptions: CustomSelectOption[] = supportedProfiles.length > 0
    ? profileOptions
    : [{ value: 'BALANCED', label: 'Umbral fijo del modelo', disabled: true }]
  const modeOptions: CustomSelectOption[] = PARAGRAPH_MODES.map((item) => ({
    value: item,
    label: item === 'STRICT_PARAGRAPH' ? 'Solo el párrafo (Recomendado)' : 'Con contexto breve (Experimental)',
  }))
  const languageOptions: CustomSelectOption[] = [
    { value: 'es', label: 'Español · calibración española' },
    { value: 'en', label: 'Inglés · calibración global' },
    { value: 'other', label: 'Otro o desconocido · calibración global' },
  ]

  useEffect(() => () => {
    requestIdRef.current += 1
    abortControllerRef.current?.abort()
    if (mascotCueTimeoutRef.current !== null) window.clearTimeout(mascotCueTimeoutRef.current)
  }, [])

  useEffect(() => {
    if (!isSubmitting) return
    const readingTimeout = window.setTimeout(() => setLoadingMascotState('reading'), 650)
    const analyzingTimeout = window.setTimeout(() => setLoadingMascotState('analyzing'), 1750)
    return () => {
      window.clearTimeout(readingTimeout)
      window.clearTimeout(analyzingTimeout)
    }
  }, [isSubmitting])

  useEffect(() => {
    if (!copyFeedback) return
    const timeout = window.setTimeout(() => setCopyFeedback(null), 1500)
    return () => window.clearTimeout(timeout)
  }, [copyFeedback])

  function clearResult() {
    setSnapshot(null)
    setError(null)
    setCanRetry(false)
    setErrorMascotState('error')
    clearMascotCue()
  }

  function clearMascotCue() {
    if (mascotCueTimeoutRef.current !== null) window.clearTimeout(mascotCueTimeoutRef.current)
    mascotCueTimeoutRef.current = null
    setMascotCue(null)
  }

  function showMascotCue(state: MascotState, duration = 850) {
    if (mascotCueTimeoutRef.current !== null) window.clearTimeout(mascotCueTimeoutRef.current)
    setMascotCue(state)
    mascotCueTimeoutRef.current = window.setTimeout(() => {
      mascotCueTimeoutRef.current = null
      setMascotCue(null)
    }, duration)
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (requestPendingRef.current || !text.trim() || isOverLimit || models.isLoading || models.isError || !analyzerUsable) return

    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    const controller = new AbortController()
    abortControllerRef.current = controller
    requestPendingRef.current = true
    clearMascotCue()
    setLoadingMascotState('stand-up')
    setIsSubmitting(true)
    setError(null)
    setCanRetry(false)
    setSnapshot(null)
    const analyzedTextSnapshot = text
    const analyzedParagraphs = splitQuickTextParagraphs(analyzedTextSnapshot)
    const analyzedAnalyzer = selectedAnalyzer
    const analyzedProfile = profile
    const analyzedMode = mode
    const analyzedLanguage = languageCode
    const response = await runQuickAnalysis(analyzedTextSnapshot, (input) => analyzeQuickText(input, {
      analyzer: selectedAnalyzer,
      thresholdProfile: profile,
      paragraphMode: mode,
      ...(isLanguageCalibrationAnalyzer(selectedAnalyzer) ? { languageCode } : {}),
    }, controller.signal))
    if (requestId !== requestIdRef.current || controller.signal.aborted) return
    if (response.result) {
      setSnapshot({
        result: response.result,
        text: analyzedTextSnapshot,
        paragraphTexts: analyzedParagraphs,
        analyzer: analyzedAnalyzer,
        profile: analyzedProfile,
        mode: analyzedMode,
        languageCode: analyzedLanguage,
      })
      showMascotCue(response.result.evaluated ? 'success' : 'warning')
    }
    setError(response.error)
    setCanRetry(response.retryable)
    if (response.mascotState) setErrorMascotState(response.mascotState)
    requestPendingRef.current = false
    abortControllerRef.current = null
    setIsSubmitting(false)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isQuickAnalysisShortcut(event)) {
      event.preventDefault()
      void submit()
    }
  }

  const resultState = isSubmitting ? 'loading' : error ? 'error' : result ? null : 'idle'
  const resultIsStale = snapshot ? isQuickResultStale(text, snapshot.text) : false
  const quickMascotState: MascotState = mascotCue ?? (resultState === 'loading'
    ? loadingMascotState
    : resultState === 'error'
      ? errorMascotState
      : !text.length
        ? 'idle'
        : text.trim()
          ? 'ready'
          : 'empty')

  async function copyToClipboard(value: string, successMessage = 'Resultado copiado.') {
    try {
      const method = await copyPlainText(value)
      setCopyFeedback({ type: 'success', message: method === 'fallback' ? 'Copiado.' : successMessage })
      showMascotCue('copy')
    } catch (copyError) {
      setCopyFeedback({ type: 'error', message: copyError instanceof Error ? copyError.message : 'No se pudo copiar el resultado.' })
      showMascotCue('warning')
    }
  }

  function copyAllResult() {
    if (!snapshot) return
    void copyToClipboard(formatQuickResultCopy(snapshot.result, snapshot.paragraphTexts, {
      analyzer: ANALYZER_LABEL[snapshot.analyzer],
      profile: isLanguageCalibrationAnalyzer(snapshot.analyzer)
        ? 'Umbral fijo del modelo según idioma'
        : PROFILE_LABEL[snapshot.profile],
      mode: snapshot.mode,
      language: snapshot.result.languageCode.toUpperCase(),
    }), 'Análisis completo copiado.')
  }

  function copyParagraph(paragraph: QuickAnalysisResponse['paragraphs'][number]) {
    if (!snapshot) return
    void copyToClipboard(formatQuickParagraphCopy(paragraph, snapshot.paragraphTexts[paragraph.index]), 'Párrafo copiado.')
  }

  function clearText() {
    requestIdRef.current += 1
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    requestPendingRef.current = false
    setText('')
    setSnapshot(null)
    setError(null)
    setCanRetry(false)
    setIsSubmitting(false)
    setFilter('all')
    setErrorMascotState('error')
    showMascotCue('clear', 900)
    setCopyFeedback({ type: 'success', message: 'Contenido eliminado.' })
  }

  return (
    <div className="quick-page">
      <header className="quick-page-heading">
        <div className="quick-title-icon" aria-hidden="true"><Icon name="spark" size={20} /></div>
        <div>
          <p className="quick-eyebrow">Análisis rápido</p>
          <h1>Analiza un texto</h1>
          <p className="quick-page-intro">Elige el idioma, perfil, modo y analizador; luego pega el texto para revisar el puntaje local y las señales por párrafo.</p>
        </div>
      </header>

      <div className="quick-analysis-layout">
        <form className="quick-input-card" onSubmit={submit}>
          <div className="quick-input-heading">
            <p className="quick-eyebrow">Entrada</p>
            <h2>Configura y pega tu texto</h2>
          </div>
          <fieldset className="quick-analysis-settings" disabled={isSubmitting}>
            <legend>Configuración del análisis</legend>
            <div className="quick-analysis-settings-grid">
              <div className="quick-setting-field">
                <span>Analizador</span>
                <CustomSelect
                  id="quick-analysis-analyzer"
                  label="Analizador"
                  value={selectedAnalyzer}
                  options={analyzerOptions}
                  disabled={isSubmitting}
                  onChange={(event) => {
                    const next = event as AnalyzerName
                    setAnalyzerTouched(true)
                    setAnalyzer(next)
                    const nextModel = models.data?.items.find((item) => item.name === MODEL_FOR_ANALYZER[next])
                    const nextSupportedProfiles = getSelectableThresholdProfiles(THRESHOLD_PROFILES, nextModel?.thresholdProfiles)
                    setProfile(reconcileThresholdProfile(profile, nextSupportedProfiles))
                    clearResult()
                  }}
                />
              </div>

              <div className="quick-setting-field">
                <span>Perfil</span>
                <CustomSelect
                  id="quick-analysis-profile"
                  label="Perfil"
                  value={profile}
                  options={displayedProfileOptions}
                  disabled={isSubmitting || supportedProfiles.length === 0}
                  onChange={(next) => {
                    setProfile(next as ThresholdProfileName)
                    clearResult()
                  }}
                />
              </div>

              <div className="quick-setting-field">
                <span>Modo de párrafo</span>
                <CustomSelect
                  id="quick-analysis-mode"
                  label="Modo de párrafo"
                  value={mode}
                  options={modeOptions}
                  disabled={isSubmitting}
                  onChange={(next) => {
                    setMode(next as ParagraphModeName)
                    clearResult()
                  }}
                />
              </div>

              {isLanguageCalibrationAnalyzer(selectedAnalyzer) && (
                <div className="quick-setting-field">
                  <span>Idioma para calibración</span>
                  <CustomSelect
                    id="quick-analysis-language"
                    label="Idioma para calibración"
                    value={languageCode}
                    options={languageOptions}
                    disabled={isSubmitting}
                    onChange={(next) => {
                      setLanguageCode(next as LanguageCode)
                      clearResult()
                    }}
                  />
                </div>
              )}
            </div>
          </fieldset>

          {models.isLoading && <p className="quick-config-message" role="status">Consultando disponibilidad de los analizadores…</p>}
          {models.isError && <p className="quick-config-message is-error" role="status">No se pudo consultar la disponibilidad de los analizadores. El análisis está deshabilitado hasta verificarla.</p>}
          {!models.isLoading && !models.isError && !analyzerUsable && <p className="quick-config-message is-error" role="status">El analizador elegido no está disponible localmente. Elige otro que aparezca habilitado.</p>}
          {models.data?.localPreferredWarning && <p className="quick-config-message" role="status">{models.data.localPreferredWarning}</p>}

          <label className="quick-input-label" htmlFor="quick-analysis-text">Texto a analizar</label>
          <textarea
            id="quick-analysis-text"
            value={text}
            onChange={(event) => {
              setText(event.currentTarget.value)
              if (!snapshot) {
                setError(null)
                setCanRetry(false)
              }
            }}
            onKeyDown={handleKeyDown}
            placeholder="Pega aquí uno o varios párrafos…"
            aria-describedby="quick-input-help quick-input-count"
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
            <button className="quick-submit-button" type="submit" disabled={isSubmitting || !text.trim() || isOverLimit || models.isLoading || models.isError || !analyzerUsable}>
              {isSubmitting ? <><span className="quick-spinner" aria-hidden="true" /> Analizando…</> : <><Icon name="spark" size={16} /> Analizar texto</>}
            </button>
            <button
              className="quick-clear-button"
              type="button"
              onClick={clearText}
              disabled={!text.length && !snapshot && !isSubmitting && !error}
            >
              Limpiar todo
            </button>
            <span className="quick-shortcut-hint">Atajo: Ctrl/Cmd + Enter</span>
          </div>
          <p className="quick-privacy-note"><Icon name="shield-check" size={14} /> No se crea documento, reporte ni entrada de historial.</p>
        </form>

        <div className="quick-result-column">
          {result && snapshot ? (
            <QuickResultSummary
              result={result}
              paragraphTexts={snapshot.paragraphTexts}
              analyzer={snapshot.analyzer}
              profile={snapshot.profile}
              mode={snapshot.mode}
              stale={resultIsStale}
              filter={filter}
              onFilterChange={setFilter}
              onCopyAll={copyAllResult}
              onCopyParagraph={copyParagraph}
              onReanalyze={() => void submit()}
              mascotState={mascotCue ?? (resultIsStale ? 'warning' : undefined)}
            />
          ) : (
            <QuickStatusPanel
              status={resultState ?? 'idle'}
              message={error ?? undefined}
              retryable={canRetry}
              onRetry={() => void submit()}
              mascotState={quickMascotState}
            />
          )}
        </div>
      </div>
      {copyFeedback && (
        <div className={`quick-copy-toast is-${copyFeedback.type}`} role="status" aria-live="polite">
          <Icon name={copyFeedback.type === 'success' ? 'check' : 'file'} size={15} />
          {copyFeedback.message}
        </div>
      )}
    </div>
  )
}

export default QuickAnalysisPage
