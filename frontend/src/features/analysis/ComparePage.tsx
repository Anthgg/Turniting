import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { CustomSelect } from '../../components/CustomSelect'
import { TurnitingFeedback } from '../../components/TurnitingFeedback'
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
      <div className="compare-picker-field">
        <span>Documento</span>
        <CustomSelect
          id={`compare-${label.toLocaleLowerCase('es-PE').replace(/\s+/gu, '-')}-document`}
          label={`${label} · documento`}
          value={documentId}
          options={[
            { value: '', label: 'Selecciona…' },
            ...(docs.data?.items.map((d) => ({ value: d.id, label: d.originalName })) ?? []),
          ]}
          onChange={(value) => { setDocumentId(value); onChange('', null) }}
        />
      </div>
      {docs.isError && <TurnitingFeedback state="network-error" title="No se pudo cargar la lista de documentos" className="analysis-notice analysis-error" layout="inline" />}
      {historyError && (
        <TurnitingFeedback state="network-error" title="No se pudo cargar el historial de análisis" description={operationErrorMessage('historyError')} className="analysis-notice analysis-error" layout="inline">
          <button className="button button-quiet" type="button" onClick={() => void runs.refetch()}>Reintentar historial</button>
        </TurnitingFeedback>
      )}
      <div className="compare-picker-field">
        <span>Análisis</span>
        <CustomSelect
          id={`compare-${label.toLocaleLowerCase('es-PE').replace(/\s+/gu, '-')}-analysis`}
          label={`${label} · análisis`}
          value={value}
          disabled={!documentId}
          options={[
            { value: '', label: 'Selecciona…' },
            ...(runs.data?.items.filter((r) => r.status === 'COMPLETED').map((r) => ({
              value: r.id,
              label: `${ANALYZER_LABEL[r.analyzerMode]} · ${r.paragraphMode === 'CONTEXTUAL_PARAGRAPH' ? 'Con contexto breve' : 'Solo el párrafo'} · ${PROFILE_LABEL[r.thresholdProfile] ?? r.thresholdProfile} · ${r.documentScorePercent === undefined ? formatSignal(r.documentScore) : formatPercentPoints(r.documentScorePercent)} · ${new Date(r.createdAt).toLocaleString()}`,
            })) ?? []),
          ]}
          onChange={(id) => onChange(id, runs.data?.items.find((run) => run.id === id)?.paragraphMode ?? null)}
        />
      </div>
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
        {compare.isPending && <TurnitingFeedback state="analyzing" title="Comparando las versiones" description="Alineando párrafos y contrastando sus señales. No se usa un porcentaje de progreso estimado." className="compare-feedback" layout="inline" />}
        {comparisonError instanceof ApiRequestError && <ApiErrorNotice error={comparisonError} title={operationErrorMessage('comparisonError')} />}
        {comparisonError && !(comparisonError instanceof ApiRequestError) && (
          <TurnitingFeedback state="network-error" title="No se pudo comparar las versiones" description={operationErrorMessage('comparisonError')} className="analysis-notice analysis-error" layout="inline">
            <button className="button button-quiet" type="button" onClick={() => { compare.reset(); compare.mutate() }}>Reintentar comparación</button>
          </TurnitingFeedback>
        )}
      </section>

      {data && (
        <TurnitingFeedback state="result-reveal" title="Comparación completada" description="Los resultados de ambas versiones están listos para revisar." className="compare-feedback" layout="inline" />
      )}

      {data && (
        <section className="document-panel" aria-label="Resultado de la comparación">
          <p className="analysis-disclaimer">{data.disclaimer}</p>
          <div className="analysis-summary">
            <div><span>Versión A</span><strong>{formatSignal(data.details.baseDocumentScore)}</strong></div>
            <div><span>Versión B</span><strong>{formatSignal(data.details.targetDocumentScore)}</strong></div>
            <div><span>Diferencia</span><strong>{formatDelta(data.globalScoreDelta)}</strong></div>
            <div><span>Similitud del texto</span><strong>{formatSignal(data.documentSimilarity)}</strong></div>
            <div><span>Párrafos</span><strong>{data.unchangedSegments} sin cambios · {data.changedSegments} modificados · {data.addedSegments} añadidos · {data.removedSegments} eliminados</strong></div>
            {data.details.thresholdReview && (
              <div>
                <span>Señalados por umbral</span>
                <strong>
                  A: {data.details.thresholdReview.previousFlagged} · B: {data.details.thresholdReview.currentFlagged} · {data.details.thresholdReview.newlyFlagged} nuevos · {data.details.thresholdReview.noLongerFlagged} ya no señalados · {data.details.thresholdReview.stillFlagged} se mantienen
                </strong>
              </div>
            )}
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
