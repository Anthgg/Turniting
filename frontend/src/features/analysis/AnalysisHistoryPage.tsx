import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ApiErrorNotice } from '../documents/ApiErrorNotice'
import {
  analysisHistoryQueryKeys,
  loadAnalysisHistory,
  type AnalysisHistoryEntry,
} from './analysis-history-data'
import './AnalysisHistoryPage.css'

type AnalysisRun = AnalysisHistoryEntry['run']

function dateLabel(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Fecha no disponible'
    : new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function percent(value: number | null) {
  return value == null ? 'No evaluado' : `${(value * 100).toFixed(1)} %`
}

function analyzerLabel(value: string) {
  const labels: Record<string, string> = {
    V3_ONLY: 'Analizador local V3',
    V2_ONLY: 'Analizador local V2',
    ENSEMBLE: 'Ensamble local',
    F006_1_ONLY: 'Modelo experimental F006.1',
    F006_1_1_ONLY: 'Modelo experimental F006.1.1',
  }
  return labels[value] ?? 'Analizador local'
}

function modelLabel(run: AnalysisRun) {
  const modelNames = run.modelResults?.map((model) => model.modelName).filter(Boolean) ?? []
  return modelNames.length > 0 ? modelNames.map(analyzerLabel).join(' + ') : analyzerLabel(run.analyzerMode)
}

function classificationLabel(run: AnalysisRun) {
  if (run.documentScore === null || run.documentClassification === 'INSUFFICIENT_TEXT') return 'No evaluado'
  return run.documentClassification === 'MACHINE_SIGNAL' ? 'Señalado por detector' : 'Señal baja'
}

export function AnalysisHistoryPage() {
  const [page, setPage] = useState(1)
  const [filterReferenceTime] = useState(() => Date.now())
  const [documentFilter, setDocumentFilter] = useState('')
  const [dateFilter, setDateFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [modelFilter, setModelFilter] = useState('all')
  const history = useQuery({
    queryKey: analysisHistoryQueryKeys.page(page, 12),
    queryFn: () => loadAnalysisHistory(page, 12),
    retry: 1,
  })

  const modelOptions = useMemo(() => [...new Set((history.data?.entries ?? []).map(({ run }) => modelLabel(run)))].sort(), [history.data])
  const filteredEntries = useMemo(() => {
    const cutoff = dateFilter === 'all' ? null : filterReferenceTime - Number(dateFilter) * 24 * 60 * 60 * 1000
    const term = documentFilter.trim().toLocaleLowerCase('es-PE')
    return (history.data?.entries ?? []).filter(({ document, run }) => {
      const matchesDocument = !term || document.originalName.toLocaleLowerCase('es-PE').includes(term)
      const timestamp = Date.parse(run.createdAt)
      const matchesDate = cutoff === null || (!Number.isNaN(timestamp) && timestamp >= cutoff)
      const matchesType = typeFilter === 'all' || run.analyzerMode === typeFilter
      const matchesModel = modelFilter === 'all' || modelLabel(run) === modelFilter
      return matchesDocument && matchesDate && matchesType && matchesModel
    })
  }, [history.data, documentFilter, dateFilter, typeFilter, modelFilter, filterReferenceTime])

  const analyzerModes = useMemo(() => [...new Set((history.data?.entries ?? []).map(({ run }) => run.analyzerMode))].sort(), [history.data])

  return (
    <div className="dashboard-main analysis-history-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">RESULTADOS</p>
          <h1>Historial de análisis</h1>
          <p className="page-subtitle">Consulta las corridas recientes guardadas con cada documento y vuelve a su revisión.</p>
        </div>
        <Link className="button button-primary" to="/documents">Analizar documento</Link>
      </header>

      {history.isError && <ApiErrorNotice error={history.error} title="No se pudo cargar el historial" />}
      {history.data && (
        <>
          <section className="history-filter-panel" aria-label="Filtros del historial">
            <label className="history-search">
              <span>Documento</span>
              <input value={documentFilter} onChange={(event) => setDocumentFilter(event.currentTarget.value)} placeholder="Buscar por nombre" />
            </label>
            <label>
              <span>Fecha</span>
              <select value={dateFilter} onChange={(event) => setDateFilter(event.currentTarget.value)}>
                <option value="all">Cualquier fecha</option>
                <option value="7">Últimos 7 días</option>
                <option value="30">Últimos 30 días</option>
              </select>
            </label>
            <label>
              <span>Tipo</span>
              <select value={typeFilter} onChange={(event) => setTypeFilter(event.currentTarget.value)}>
                <option value="all">Todos</option>
                {analyzerModes.map((mode) => <option value={mode} key={mode}>{analyzerLabel(mode)}</option>)}
              </select>
            </label>
            <label>
              <span>Modelo</span>
              <select value={modelFilter} onChange={(event) => setModelFilter(event.currentTarget.value)}>
                <option value="all">Todos</option>
                {modelOptions.map((model) => <option value={model} key={model}>{model}</option>)}
              </select>
            </label>
          </section>

          {history.data.failedDocuments > 0 && (
            <p className="history-partial-warning" role="status">
              No se pudo cargar el historial de {history.data.failedDocuments} documento(s); se muestran los demás resultados.
            </p>
          )}

          {filteredEntries.length === 0 ? (
            <section className="history-empty-state">
              <strong>{history.data.entries.length === 0 ? 'Aún no hay análisis' : 'No hay resultados con estos filtros'}</strong>
              <span>{history.data.entries.length === 0 ? 'Cuando ejecutes un análisis documental, aparecerá aquí.' : 'Prueba con otro nombre, periodo, tipo o modelo.'}</span>
              {history.data.entries.length === 0 && <Link className="button button-secondary" to="/documents">Analizar documento</Link>}
            </section>
          ) : (
            <section className="analysis-history-list" aria-label="Corridas de análisis">
              {filteredEntries.map(({ document, run }) => (
                <article className="analysis-history-card" key={run.id}>
                  <div className="analysis-history-main">
                    <div>
                      <p className="eyebrow">{dateLabel(run.createdAt)}</p>
                      <h2><Link to={`/documents/${document.id}`}>{document.originalName}</Link></h2>
                      <p className="analysis-history-meta">{analyzerLabel(run.analyzerMode)} · {run.status === 'COMPLETED' ? classificationLabel(run) : run.status === 'FAILED' ? 'Análisis fallido' : 'En proceso'}</p>
                    </div>
                    <div className="analysis-history-score">
                      <span>Señal global estimada</span>
                      <strong>{percent(run.documentScore)}</strong>
                    </div>
                  </div>
                  <div className="analysis-history-actions">
                    <details>
                      <summary>Detalles técnicos</summary>
                      <dl>
                        <div><dt>Modelo</dt><dd>{run.modelResults?.map((model) => model.modelName).join(' + ') || run.analyzerMode}</dd></div>
                        <div><dt>Perfil científico</dt><dd>{run.thresholdProfile}</dd></div>
                        <div><dt>Umbral científico</dt><dd>{percent(run.threshold)}</dd></div>
                        <div><dt>ID de corrida</dt><dd>{run.id}</dd></div>
                      </dl>
                    </details>
                    <Link className="button button-quiet" to={`/documents/${document.id}`}>Abrir revisión</Link>
                    <Link className="button button-quiet" to="/reports">Ver reportes</Link>
                  </div>
                </article>
              ))}
            </section>
          )}

          {history.data.totalPages > 1 && (
            <nav className="history-pagination" aria-label="Páginas del historial">
              <button type="button" className="button button-quiet" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1 || history.isFetching}>Anterior</button>
              <span>Página {page} de {history.data.totalPages}</span>
              <button type="button" className="button button-quiet" onClick={() => setPage((value) => Math.min(history.data!.totalPages, value + 1))} disabled={page >= history.data.totalPages || history.isFetching}>Siguiente</button>
            </nav>
          )}
        </>
      )}
      {history.isPending && <div className="documents-empty-state" role="status"><span className="state-indicator is-animated" /><span>Cargando historial…</span></div>}
    </div>
  )
}
