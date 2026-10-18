import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { compareAnalyses, listDocumentAnalyses } from '../../api/analysis'
import { ApiRequestError } from '../../api/client'
import { documentQueryKeys, listDocuments } from '../../api/documents'
import { ApiErrorNotice } from '../documents/ApiErrorNotice'
import {
  ANALYZER_LABEL,
  COMPARISON_LABEL,
  PROFILE_LABEL,
  formatDelta,
  formatPercentPoints,
  formatSignal,
  operationErrorMessage,
} from './analysis-utils'

function AnalysisPicker({ label, value, onChange }: { label: string; value: string; onChange: (id: string, paragraphMode: string | null) => void }) {
  const [documentId, setDocumentId] = useState('')
  const docs = useQuery({ queryKey: documentQueryKeys.list(1, 100), queryFn: () => listDocuments(1, 100), retry: 1 })
  const runs = useQuery({ queryKey: ['analysis', 'document', documentId], queryFn: () => listDocumentAnalyses(documentId),
    enabled: Boolean(documentId), retry: 1 })
  const historyError = runs.isError ? runs.error : null
  return (
    <fieldset className="compare-picker">
      <legend>{label}</legend>
      <label>
        <span>Documento</span>
        <select value={documentId} onChange={(e) => { setDocumentId(e.currentTarget.value); onChange('', null) }}>
          <option value="">Selecciona…</option>
          {docs.data?.items.map((d) => <option key={d.id} value={d.id}>{d.originalName}</option>)}
        </select>
      </label>
      {docs.isError && <p className="analysis-notice analysis-error" role="alert">No se pudo cargar la lista de documentos.</p>}
      {historyError && (
        <p className="analysis-notice analysis-error" role="alert">
          {operationErrorMessage('historyError')}
          <button className="button button-quiet" type="button" onClick={() => void runs.refetch()}>Reintentar historial</button>
        </p>
      )}
      <label>
        <span>Análisis</span>
        <select value={value} onChange={(e) => {
          const id = e.currentTarget.value
          onChange(id, runs.data?.items.find((run) => run.id === id)?.paragraphMode ?? null)
        }} disabled={!documentId}>
          <option value="">Selecciona…</option>
          {runs.data?.items.filter((r) => r.status === 'COMPLETED').map((r) => (
            <option key={r.id} value={r.id}>
              {ANALYZER_LABEL[r.analyzerMode]} · {r.paragraphMode === 'CONTEXTUAL_PARAGRAPH' ? 'Con contexto breve' : 'Solo el párrafo'} · {PROFILE_LABEL[r.thresholdProfile] ?? r.thresholdProfile} · {r.documentScorePercent === undefined ? formatSignal(r.documentScore) : formatPercentPoints(r.documentScorePercent)} · {new Date(r.createdAt).toLocaleString()}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  )
}

export function ContextualComparisonNotice({ paragraphModes }: { paragraphModes: Array<string | null> }) {
  if (!paragraphModes.includes('CONTEXTUAL_PARAGRAPH')) return null
  return (
    <p className="analysis-notice analysis-context-comparison-warning" role="status">
      En modo contextual, modificar un párrafo puede cambiar también la señal de párrafos vecinos porque forman parte del contexto de inferencia.
    </p>
  )
}

export function ComparePage() {
  const [base, setBase] = useState('')
  const [target, setTarget] = useState('')
  const [baseParagraphMode, setBaseParagraphMode] = useState<string | null>(null)
  const [targetParagraphMode, setTargetParagraphMode] = useState<string | null>(null)
  const compare = useMutation({ mutationFn: () => compareAnalyses(base, target) })
  const comparisonError = compare.isError ? compare.error : null
  const updateBase = (id: string, paragraphMode: string | null) => {
    setBase(id)
    setBaseParagraphMode(paragraphMode)
    compare.reset()
  }
  const updateTarget = (id: string, paragraphMode: string | null) => {
    setTarget(id)
    setTargetParagraphMode(paragraphMode)
    compare.reset()
  }
  const data = compare.data

  return (
    <div className="dashboard-main analysis-compare-main">
      <div className="page-heading">
        <div>
          <p className="eyebrow">COMPARACIÓN DE VERSIONES</p>
          <h1>Comparar dos versiones de un documento</h1>
          <p className="page-subtitle">Alinea los párrafos de dos análisis hechos con el mismo analizador y perfil, y muestra cómo cambió la señal estimada.</p>
        </div>
      </div>
      <section className="document-panel">
        <div className="compare-pickers">
          <AnalysisPicker label="Versión A" value={base} onChange={updateBase} />
          <AnalysisPicker label="Versión B" value={target} onChange={updateTarget} />
        </div>
        <ContextualComparisonNotice paragraphModes={[baseParagraphMode, targetParagraphMode]} />
        <button className="button button-primary" type="button" disabled={!base || !target || compare.isPending} onClick={() => { compare.reset(); compare.mutate() }}>
          {compare.isPending ? 'Comparando…' : 'Comparar'}
        </button>
        {comparisonError instanceof ApiRequestError && <ApiErrorNotice error={comparisonError} title={operationErrorMessage('comparisonError')} />}
        {comparisonError && !(comparisonError instanceof ApiRequestError) && (
          <p className="analysis-notice analysis-error" role="alert">
            {operationErrorMessage('comparisonError')}
            <button className="button button-quiet" type="button" onClick={() => { compare.reset(); compare.mutate() }}>Reintentar comparación</button>
          </p>
        )}
      </section>

      {data && (
        <section className="document-panel" aria-label="Resultado de la comparación">
          <p className="analysis-disclaimer">{data.disclaimer}</p>
          <div className="analysis-summary">
            <div><span>Versión A</span><strong>{formatSignal(data.details.baseDocumentScore)}</strong></div>
            <div><span>Versión B</span><strong>{formatSignal(data.details.targetDocumentScore)}</strong></div>
            <div><span>Diferencia</span><strong>{formatDelta(data.globalScoreDelta)}</strong></div>
            <div><span>Similitud del texto</span><strong>{formatSignal(data.documentSimilarity)}</strong></div>
            <div><span>Párrafos</span><strong>{data.unchangedSegments} sin cambios · {data.changedSegments} modificados · {data.addedSegments} añadidos · {data.removedSegments} eliminados</strong></div>
            <div><span>Deriva en párrafos sin cambios</span><strong>{data.details.unchangedDrift ? `mediana ${formatDelta(data.details.unchangedDrift.median)} · p95 ${formatDelta(data.details.unchangedDrift.p95)}` : '—'}</strong></div>
          </div>
          <table className="dataset-table compare-table">
            <thead><tr><th>Párrafo A</th><th>Párrafo B</th><th>Estado</th><th>Señal A</th><th>Señal B</th><th>Cambio</th></tr></thead>
            <tbody>
              {data.details.paragraphs.map((p, i) => (
                <tr key={i} className={`compare-${p.status.toLowerCase()}`}>
                  <td>{p.baseParagraphIndex === null ? '—' : `#${p.baseParagraphIndex + 1}`}</td>
                  <td>{p.targetParagraphIndex === null ? '—' : `#${p.targetParagraphIndex + 1}`}</td>
                  <td>{COMPARISON_LABEL[p.status]}</td>
                  <td>{formatSignal(p.baseScore)}</td>
                  <td>{formatSignal(p.targetScore)}</td>
                  <td>{formatDelta(p.delta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
