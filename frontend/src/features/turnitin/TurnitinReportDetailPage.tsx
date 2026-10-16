import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  deleteTurnitinReport,
  getTurnitinReport,
  listTurnitinSegments,
  listTurnitinSources,
  ocrReparseTurnitinReport,
  reparseTurnitinReport,
  turnitinQueryKeys,
} from '../../api/turnitin'
import { ApiErrorNotice } from '../documents/ApiErrorNotice'

const PAGE_SIZE = 50

function scoreLabel(raw: string | null, percentage: number | null) {
  if (raw) return raw
  return percentage === null ? 'No disponible' : `${percentage}%`
}

function segmentLabel(type: string) {
  if (type === 'AI_FLAGGED') return 'Marcado como IA en el reporte'
  if (type === 'SIMILARITY_MATCH') return 'Coincidencia resaltada'
  if (type === 'NOT_FLAGGED') return 'Sin resaltado en este reporte'
  return 'Tipo no identificado'
}

function matchLabel(status: string) {
  const labels: Record<string, string> = {
    UNVERIFIED: 'Sin verificar', EXACT: 'Exacto', HIGH: 'Alto', PARTIAL: 'Parcial', MISMATCH: 'Distinto',
  }
  return labels[status] ?? status
}

export function TurnitinReportDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [sourcePage, setSourcePage] = useState(1)
  const [segmentPage, setSegmentPage] = useState(1)
  const report = useQuery({
    queryKey: turnitinQueryKeys.detail(id),
    queryFn: () => getTurnitinReport(id),
    enabled: Boolean(id),
    retry: 1,
  })
  const sources = useQuery({
    queryKey: turnitinQueryKeys.sources(id, sourcePage),
    queryFn: () => listTurnitinSources(id, sourcePage),
    enabled: Boolean(id) && (report.data?.sourceCount ?? 0) > 0,
    retry: 1,
  })
  const segments = useQuery({
    queryKey: turnitinQueryKeys.segments(id, segmentPage),
    queryFn: () => listTurnitinSegments(id, segmentPage, PAGE_SIZE),
    enabled: Boolean(id) && (report.data?.segmentCount ?? 0) > 0,
    retry: 1,
  })
  const reparse = useMutation({
    mutationFn: () => reparseTurnitinReport(id),
    onSuccess: (updated) => {
      queryClient.setQueryData(turnitinQueryKeys.detail(id), updated)
      void queryClient.invalidateQueries({ queryKey: turnitinQueryKeys.all })
      void queryClient.invalidateQueries({ queryKey: ['turnitin-reports', 'sources', id] })
      void queryClient.invalidateQueries({ queryKey: ['turnitin-reports', 'segments', id] })
    },
  })
  const ocrReparse = useMutation({
    mutationFn: () => ocrReparseTurnitinReport(id),
    onSuccess: (updated) => {
      queryClient.setQueryData(turnitinQueryKeys.detail(id), updated)
      void queryClient.invalidateQueries({ queryKey: turnitinQueryKeys.all })
      void queryClient.invalidateQueries({ queryKey: ['turnitin-reports', 'sources', id] })
      void queryClient.invalidateQueries({ queryKey: ['turnitin-reports', 'segments', id] })
    },
  })
  const remove = useMutation({
    mutationFn: () => deleteTurnitinReport(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: turnitinQueryKeys.all })
      navigate('/turnitin-reports', { replace: true })
    },
  })

  function confirmDelete() {
    if (window.confirm('¿Eliminar este reporte y su PDF local? El documento original vinculado no se eliminará.')) remove.mutate()
  }

  const record = report.data
  const primary = record?.reportType === 'AI_WRITING'
    ? record.scores.aiWriting
    : record?.scores.similarity

  return (
    <div className="dashboard-main turnitin-main">
      <div className="page-heading document-detail-heading">
        <div>
          <p className="eyebrow">DETALLE DEL REPORTE</p>
          <h1>{record?.originalName ?? (report.isPending ? 'Cargando reporte…' : 'Reporte Turnitin')}</h1>
          <p className="page-subtitle">Lectura del contenido visible del PDF; no replica el algoritmo de Turnitin.</p>
        </div>
        <div className="document-detail-actions">
          <Link className="button button-quiet" to="/turnitin-reports">Todos los reportes</Link>
          {record && <button className="button button-quiet" type="button" onClick={() => reparse.mutate()} disabled={reparse.isPending}>{reparse.isPending ? 'Releyendo…' : 'Reprocesar'}</button>}
          {record?.requiresOcr && <button className="button button-primary" type="button" onClick={() => ocrReparse.mutate()} disabled={ocrReparse.isPending} aria-busy={ocrReparse.isPending}>{ocrReparse.isPending ? 'Procesando OCR…' : 'Procesar OCR local'}</button>}
          {record && <button className="button button-danger-quiet" type="button" onClick={confirmDelete} disabled={remove.isPending}>Eliminar</button>}
        </div>
      </div>

      {report.isError && <ApiErrorNotice error={report.error} title="No se pudo cargar el reporte" />}
      {reparse.isError && <ApiErrorNotice error={reparse.error} title="No se pudo reprocesar el reporte" />}
      {ocrReparse.isError && <ApiErrorNotice error={ocrReparse.error} title="No se pudo aplicar OCR al reporte" />}
      {remove.isError && <ApiErrorNotice error={remove.error} title="No se pudo eliminar el reporte" />}
      {report.isPending && <div className="documents-empty-state" role="status"><span className="state-indicator is-animated" /><span>Cargando reporte…</span></div>}

      {record && (
        <>
          <section className="document-summary-card turnitin-summary-card" aria-label="Resultado del reporte">
            <div className="document-summary-main">
              <span className="turnitin-report-icon turnitin-report-icon-large" aria-hidden="true">T</span>
              <div>
                <span className={`turnitin-status turnitin-status-${record.status.toLowerCase().replace('_', '-')}`}>{record.status}</span>
                <h2>{record.reportType === 'AI_WRITING' ? 'Reporte de escritura con IA' : record.reportType === 'SIMILARITY' ? 'Reporte de similitud' : 'Tipo de reporte no identificado'}</h2>
                <p>{record.documentPageCount ?? '—'} páginas · {record.wordCount?.toLocaleString('es-PE') ?? '—'} palabras · Parser {record.parserVersion ?? '—'}</p>
              </div>
            </div>
            <div className="turnitin-primary-score">
              <span>{record.reportType === 'AI_WRITING' ? 'Escritura con IA según el reporte' : 'Similitud general según el reporte'}</span>
              <strong>{scoreLabel(primary?.raw ?? null, primary?.percentage ?? null)}</strong>
            </div>
          </section>

          {(record.status === 'PARTIAL' || record.status === 'OCR_REQUIRED' || record.status === 'FAILED' || record.contentMatchStatus === 'MISMATCH') && (
            <section className="document-warnings turnitin-warnings" role="status">
              <h2>Revisión necesaria</h2>
              <p>{record.status === 'OCR_REQUIRED' ? 'El PDF tiene poco texto seleccionable. Puedes procesarlo con OCR local para recuperar los datos legibles.' : record.status === 'FAILED' ? 'No se pudo interpretar el reporte. Puedes volver a procesarlo.' : record.contentMatchStatus === 'MISMATCH' ? 'El contenido no coincide con el documento vinculado; verifica la asociación.' : 'Algunos datos visibles no se pudieron leer. Revisa los campos y segmentos disponibles.'}</p>
              {ocrReparse.isPending && <p role="status">Procesando páginas localmente. No hay porcentaje de progreso disponible.</p>}
              {record.alignmentStale && <p>La alineación previa quedó desactualizada y debe volver a compararse con el texto OCR.</p>}
              {record.warnings.length > 0 && <ul>{record.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>}
            </section>
          )}

          <div className="document-detail-grid turnitin-detail-grid">
            <section className="document-panel" aria-labelledby="turnitin-metadata-title">
              <div className="document-panel-heading"><div><p className="eyebrow">IDENTIFICACIÓN</p><h2 id="turnitin-metadata-title">Metadatos</h2></div></div>
              <dl className="metadata-list">
                <div><dt>Identificador de entrega</dt><dd>{record.submissionId ?? 'No encontrado'}</dd></div>
                <div><dt>Archivo de origen</dt><dd>{record.submissionFileName ?? 'No encontrado'}</dd></div>
                <div><dt>Fecha de entrega</dt><dd>{record.submittedAt ? new Date(record.submittedAt).toLocaleString('es-PE') : 'No encontrada'}</dd></div>
                <div><dt>Caracteres</dt><dd>{record.characterCount?.toLocaleString('es-PE') ?? 'No encontrado'}</dd></div>
                <div><dt>Páginas del PDF</dt><dd>{record.reportPageCount ?? 'No encontrado'}</dd></div>
                <div><dt>OCR</dt><dd>{record.requiresOcr ? 'Requerido' : 'No requerido'}</dd></div>
                <div><dt>SHA-256</dt><dd>{record.sha256}</dd></div>
                <div><dt>Documento asociado</dt><dd>{record.documentVersionId ? record.documentId ? <Link to={`/documents/${record.documentId}`}>{record.documentName ?? record.documentId}</Link> : (record.documentName ?? record.documentVersionId) : 'Sin vincular'}</dd></div>
                <div><dt>Identidad del contenido</dt><dd>{matchLabel(record.contentMatchStatus)}{record.contentSimilarityRatio !== null ? ` · ${(record.contentSimilarityRatio * 100).toFixed(1)}%` : ''}</dd></div>
                <div><dt>Relación de entrega</dt><dd>{record.submissionRelation}</dd></div>
              </dl>
            </section>

            <section className="document-panel" aria-labelledby="turnitin-scores-title">
              <div className="document-panel-heading"><div><p className="eyebrow">PORCENTAJES VISIBLES</p><h2 id="turnitin-scores-title">Resultados del reporte</h2></div></div>
              <dl className="turnitin-score-list">
                {record.reportType === 'AI_WRITING' ? (
                  <div><dt>Escritura con IA</dt><dd>{scoreLabel(record.scores.aiWriting.raw, record.scores.aiWriting.percentage)}</dd></div>
                ) : (
                  <>
                    <div><dt>Similitud general</dt><dd>{scoreLabel(record.scores.similarity.raw, record.scores.similarity.percentage)}</dd></div>
                    <div><dt>Fuentes de Internet</dt><dd>{scoreLabel(record.scores.internet.raw, record.scores.internet.percentage)}</dd></div>
                    <div><dt>Publicaciones</dt><dd>{scoreLabel(record.scores.publications.raw, record.scores.publications.percentage)}</dd></div>
                    <div><dt>Trabajos de estudiantes</dt><dd>{scoreLabel(record.scores.studentPapers.raw, record.scores.studentPapers.percentage)}</dd></div>
                  </>
                )}
              </dl>
              {record.filters.length > 0 && <div className="turnitin-filter-list"><strong>Filtros del informe</strong><ul>{record.filters.map((filter) => <li key={filter}>{filter}</li>)}</ul></div>}
              {record.reportType === 'AI_WRITING' && <p className="turnitin-caution">El porcentaje pertenece al reporte importado. Los segmentos no marcados no demuestran autoría humana.</p>}
            </section>
          </div>

          <section className="documents-section turnitin-list-section" aria-labelledby="turnitin-sources-title">
            <div className="documents-section-heading"><div><p className="eyebrow">COINCIDENCIAS VISIBLES</p><h2 id="turnitin-sources-title">Fuentes ({record.sourceCount})</h2></div></div>
            {sources.isError && <ApiErrorNotice error={sources.error} title="No se pudieron cargar las fuentes" />}
            {sources.data?.items.length ? (
              <ul className="turnitin-source-list">{sources.data.items.map((source) => (
                <li key={source.id}>
                  <span className="turnitin-source-index" style={source.color ? { backgroundColor: source.color } : undefined}>{source.sourceIndex}</span>
                  <span><strong>{source.displayName}</strong><small>{source.sourceType.replace('_', ' ')}</small></span>
                  <b>{source.percentageRaw ?? '—'}</b>
                </li>
              ))}</ul>
            ) : sources.isPending && record.sourceCount > 0 ? <p className="full-text-status" role="status">Cargando fuentes…</p> : record.sourceCount === 0 ? <div className="documents-empty-state"><span>No se detectaron fuentes en el PDF.</span></div> : null}
            {sources.data && sources.data.totalPages > sourcePage && <button className="button button-quiet turnitin-page-button" type="button" onClick={() => setSourcePage((page) => page + 1)}>Ver más fuentes</button>}
          </section>

          <section className="documents-section turnitin-list-section" aria-labelledby="turnitin-segments-title">
            <div className="documents-section-heading"><div><p className="eyebrow">PÁGINAS DEL DOCUMENTO</p><h2 id="turnitin-segments-title">Segmentos ({record.segmentCount})</h2></div></div>
            {segments.isError && <ApiErrorNotice error={segments.error} title="No se pudieron cargar los segmentos" />}
            {segments.data?.items.map((segment) => (
              <article className={`turnitin-segment turnitin-segment-${segment.segmentType.toLowerCase().replace('_', '-')}`} key={segment.id}>
                <div className="turnitin-segment-heading"><span className="turnitin-segment-type">{segmentLabel(segment.segmentType)}</span><span>Página {segment.pageNumber}</span>{segment.source && <span>Fuente {segment.source.sourceIndex}</span>}</div>
                <p>{segment.text}</p>
              </article>
            ))}
            {segments.isPending && record.segmentCount > 0 && <p className="full-text-status" role="status">Cargando segmentos…</p>}
            {record.segmentCount === 0 && <div className="documents-empty-state"><span>No se extrajeron segmentos visibles.</span></div>}
            {segments.data && segments.data.page < segments.data.totalPages && <button className="button button-quiet turnitin-page-button" type="button" onClick={() => setSegmentPage((page) => page + 1)}>Ver más segmentos</button>}
            <p className="turnitin-caution">“Sin resaltado” significa que ese fragmento no aparece resaltado en el reporte importado. No es una conclusión sobre quién lo escribió.</p>
          </section>
        </>
      )}
    </div>
  )
}
