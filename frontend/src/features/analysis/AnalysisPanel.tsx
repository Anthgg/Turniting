import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ANALYZERS,
  PARAGRAPH_MODES,
  THRESHOLD_PROFILES,
  analysisQueryKeys,
  analyzeDocument,
  getAnalysisSegments,
  listAnalyzerModels,
  listDocumentAnalyses,
  type AnalyzerName,
  type ParagraphModeName,
  type ThresholdProfileName,
} from '../../api/analysis'
import { ApiRequestError } from '../../api/client'
import { Icon } from '../../components/Icon'
import {
  ANALYZER_LABEL,
  PROFILE_LABEL,
  SIGNAL_LABEL,
  analysisErrorMessage,
  availabilityLabel,
  formatSignal,
  isAnalyzerUsable,
  signalLevel,
} from './analysis-utils'

const MODEL_OF: Record<AnalyzerName, string[]> = {
  V3_ONLY: ['CANDIDATE_MODEL_V3'],
  V2_ONLY: ['CANDIDATE_MODEL_V2'],
  ENSEMBLE: ['CANDIDATE_MODEL_V2', 'CANDIDATE_MODEL_V3'],
}

export function AnalysisPanel({ documentId, hasText }: { documentId: string; hasText: boolean }) {
  const queryClient = useQueryClient()
  const [analyzer, setAnalyzer] = useState<AnalyzerName>('V3_ONLY')
  const [profile, setProfile] = useState<ThresholdProfileName>('LOW_FALSE_POSITIVE')
  const [mode, setMode] = useState<ParagraphModeName>('STRICT_PARAGRAPH')
  const [selectedRun, setSelectedRun] = useState<string | null>(null)

  const models = useQuery({ queryKey: analysisQueryKeys.models(), queryFn: listAnalyzerModels, retry: 1 })
  const runs = useQuery({ queryKey: analysisQueryKeys.documentAnalyses(documentId), queryFn: () => listDocumentAnalyses(documentId), retry: 1 })
  const runId = selectedRun ?? runs.data?.items.find((r) => r.status === 'COMPLETED')?.id ?? null
  const segments = useQuery({
    queryKey: analysisQueryKeys.segments(runId ?? 'none'),
    queryFn: () => getAnalysisSegments(runId as string),
    enabled: Boolean(runId),
    retry: 1,
  })
  const run = runs.data?.items.find((r) => r.id === runId)

  const analyze = useMutation({
    mutationFn: () => analyzeDocument(documentId, { analyzer, thresholdProfile: profile, paragraphMode: mode }),
    onSuccess: async (result) => {
      setSelectedRun(result.id)
      await queryClient.invalidateQueries({ queryKey: analysisQueryKeys.documentAnalyses(documentId) })
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: analysisQueryKeys.documentAnalyses(documentId) })
    },
  })

  const needed = MODEL_OF[analyzer]
  const modelStates = needed.map((name) => models.data?.items.find((m) => m.name === name))
  const usable = modelStates.every((m) => m && isAnalyzerUsable(m.availability))
  const error = analyze.error instanceof ApiRequestError ? analyze.error : null

  return (
    <section className="document-panel analysis-panel" aria-labelledby="analysis-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">ANÁLISIS LOCAL · F005</p>
          <h2 id="analysis-title">Señal de participación de IA</h2>
        </div>
        <Link className="button button-quiet" to="/analysis/compare">Comparar versiones</Link>
      </div>
      <p className="analysis-disclaimer">
        Estimación de un modelo de investigación independiente. No es un puntaje de Turnitin, no prueba autoría
        y no debe usarse por sí sola para tomar decisiones sobre una persona.
      </p>

      <div className="analysis-controls">
        <label>
          <span>Analizador</span>
          <select value={analyzer} onChange={(e) => setAnalyzer(e.currentTarget.value as AnalyzerName)}>
            {ANALYZERS.map((a) => <option key={a} value={a}>{ANALYZER_LABEL[a]}</option>)}
          </select>
        </label>
        <label>
          <span>Perfil de umbral</span>
          <select value={profile} onChange={(e) => setProfile(e.currentTarget.value as ThresholdProfileName)}>
            {THRESHOLD_PROFILES.map((p) => <option key={p} value={p}>{PROFILE_LABEL[p]}</option>)}
          </select>
        </label>
        <label>
          <span>Párrafos</span>
          <select value={mode} onChange={(e) => setMode(e.currentTarget.value as ParagraphModeName)}>
            {PARAGRAPH_MODES.map((m) => <option key={m} value={m}>{m === 'STRICT_PARAGRAPH' ? 'Solo el párrafo' : 'Con contexto breve'}</option>)}
          </select>
        </label>
        <button className="button button-primary" type="button" disabled={!hasText || analyze.isPending || !usable}
          onClick={() => analyze.mutate()} aria-busy={analyze.isPending}>
          <Icon name="spark" size={16} />
          <span>{analyze.isPending ? 'Analizando…' : 'Analizar documento'}</span>
        </button>
      </div>

      <ul className="analysis-model-status" aria-label="Estado de los modelos">
        {needed.map((name, i) => (
          <li key={name}>
            <strong>{name}</strong>
            <span>{modelStates[i] ? availabilityLabel(modelStates[i].availability) : models.isError ? 'Sin conexión con la API' : 'Comprobando…'}</span>
          </li>
        ))}
      </ul>
      {!usable && models.data && (
        <p className="analysis-notice" role="status">
          El modelo seleccionado está registrado pero sus pesos no están instalados en este equipo. Impórtalos con
          scripts/import_model_artifact.py para habilitar el análisis.
        </p>
      )}
      {!hasText && <p className="analysis-notice">El documento no tiene texto extraído todavía.</p>}
      {error && <p className="analysis-notice analysis-error" role="alert">{analysisErrorMessage(error.code, error.status)}</p>}

      {run && (
        <div className="analysis-summary" aria-label="Resultado del análisis">
          <div><span>Modelo</span><strong>{ANALYZER_LABEL[run.analyzerMode]}</strong></div>
          <div><span>Perfil</span><strong>{PROFILE_LABEL[run.thresholdProfile] ?? run.thresholdProfile}</strong></div>
          <div><span>Señal global</span><strong>{formatSignal(run.documentScore)}</strong></div>
          <div><span>Nivel</span><strong>{signalLevel(run.documentScore) ? SIGNAL_LABEL[signalLevel(run.documentScore)!] : '—'}</strong></div>
          <div><span>Párrafos evaluados</span><strong>{run.scoredSegments} · {run.insufficientSegments} con texto insuficiente</strong></div>
          <div><span>Tiempo</span><strong>{run.inferenceMs !== null ? `${(run.inferenceMs / 1000).toFixed(1)} s` : '—'}</strong></div>
        </div>
      )}
      {run?.status === 'FAILED' && <p className="analysis-notice analysis-error">El último análisis no se completó ({run.errorCode ?? 'error'}).</p>}

      {segments.data && (
        <ol className="analysis-paragraphs" aria-label="Señal por párrafo">
          {segments.data.stale && <li className="analysis-notice">El texto del documento cambió después de este análisis.</li>}
          {segments.data.items.map((s) => {
            const level = signalLevel(s.calibratedScore)
            return (
              <li key={s.paragraphIndex} className={`analysis-paragraph level-${(level ?? 'none').toLowerCase()}`}>
                <div className="analysis-paragraph-head">
                  <strong>Párrafo {s.paragraphIndex + 1}</strong>
                  <span>{s.classification === 'INSUFFICIENT_TEXT' ? 'Texto insuficiente' : `Señal IA ${formatSignal(s.calibratedScore)}`}</span>
                  {level && <span className="analysis-level">{SIGNAL_LABEL[level]}</span>}
                  {s.pageNumber !== null && <small>pág. {s.pageNumber}</small>}
                </div>
                {s.text && <p>{s.text.length > 420 ? `${s.text.slice(0, 420)}…` : s.text}</p>}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
