import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  listTurnitinReports,
  matchTurnitinReport,
  turnitinQueryKeys,
} from '../../api/turnitin'
import {
  deleteDocument,
  documentQueryKeys,
  getDocument,
  getDocumentText,
  reprocessDocument,
} from '../../api/documents'
import { Icon } from '../../components/Icon'
import { ApiErrorNotice } from './ApiErrorNotice'
import { formatBytes, formatDate, statusClass, statusLabel } from './document-utils'

const processingStatuses = new Set(['UPLOADED', 'PROCESSING'])

export function DocumentDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [showFullText, setShowFullText] = useState(false)
  const [selectedTurnitinReportId, setSelectedTurnitinReportId] = useState('')

  const document = useQuery({
    queryKey: documentQueryKeys.detail(id),
    queryFn: () => getDocument(id),
    enabled: Boolean(id),
    retry: 1,
    refetchInterval: (query) => query.state.data && processingStatuses.has(query.state.data.status) ? 2000 : false,
  })

  const text = useQuery({
    queryKey: documentQueryKeys.text(id),
    queryFn: () => getDocumentText(id),
    enabled: Boolean(id) && showFullText && document.data?.status === 'EXTRACTED',
    retry: 1,
  })

  const turnitinReports = useQuery({
    queryKey: turnitinQueryKeys.list(1, 100),
    queryFn: () => listTurnitinReports(1, 100),
    enabled: Boolean(id),
    retry: 1,
  })

  const reprocess = useMutation({
    mutationFn: () => reprocessDocument(id),
    onSuccess: (updated) => {
      queryClient.setQueryData(documentQueryKeys.detail(id), updated)
      void queryClient.invalidateQueries({ queryKey: documentQueryKeys.all })
    },
  })

  const remove = useMutation({
    mutationFn: () => deleteDocument(id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: documentQueryKeys.detail(id) })
      queryClient.removeQueries({ queryKey: documentQueryKeys.text(id) })
      void queryClient.invalidateQueries({ queryKey: documentQueryKeys.all })
      navigate('/documents', { replace: true })
    },
  })

  const matchReport = useMutation({
    mutationFn: () => matchTurnitinReport(selectedTurnitinReportId, record?.documentVersionId ?? ''),
    onSuccess: (updated) => {
      queryClient.setQueryData(turnitinQueryKeys.detail(updated.id), updated)
      void queryClient.invalidateQueries({ queryKey: turnitinQueryKeys.list(1, 100) })
      void queryClient.invalidateQueries({ queryKey: turnitinQueryKeys.all })
    },
  })

  function confirmDelete() {
    const name = document.data?.originalName ?? 'este documento'
    if (window.confirm(`¿Eliminar “${name}”? Esta acción no se puede deshacer.`)) remove.mutate()
  }

  const record = document.data
  const canReprocess = record?.status === 'FAILED' || record?.status === 'OCR_REQUIRED'
  const isProcessing = Boolean(record && processingStatuses.has(record.status))
  const turnitinItems = turnitinReports.data?.items ?? []
  const attachedTurnitinReports = record?.documentVersionId
    ? turnitinItems.filter((item) => item.documentVersionId === record.documentVersionId)
    : []
  const attachableTurnitinReports = turnitinItems.filter((item) => !item.documentVersionId || item.documentVersionId === record?.documentVersionId)

  return (
    <div className="dashboard-main document-detail-main">
      <div className="page-heading document-detail-heading">
        <div>
          <p className="eyebrow">DETALLE DEL DOCUMENTO</p>
          <h1>{record?.originalName || (document.isPending ? 'Cargando documento…' : 'Documento')}</h1>
          <p className="page-subtitle">Metadatos y texto extraído para este archivo.</p>
        </div>
        <div className="document-detail-actions">
          <Link className="button button-quiet" to="/documents">
            <Icon name="arrow-right" size={16} className="back-arrow" />
            <span>Todos los documentos</span>
          </Link>
          {record && canReprocess && (
            <button className="button button-primary" type="button" onClick={() => reprocess.mutate()} disabled={reprocess.isPending} aria-busy={reprocess.isPending}>
              <Icon name="refresh" size={16} className={reprocess.isPending ? 'is-spinning' : undefined} />
              <span>{reprocess.isPending ? 'Reprocesando…' : 'Reprocesar'}</span>
            </button>
          )}
          {record && (
            <button className="button button-danger-quiet" type="button" onClick={confirmDelete} disabled={remove.isPending}>
              <span aria-hidden="true">×</span>
              <span>{remove.isPending ? 'Eliminando…' : 'Eliminar'}</span>
            </button>
          )}
        </div>
      </div>

      {document.isError && <ApiErrorNotice error={document.error} title="No se pudo cargar el documento" />}
      {reprocess.isError && <ApiErrorNotice error={reprocess.error} title="No se pudo reprocesar el documento" />}
      {remove.isError && <ApiErrorNotice error={remove.error} title="No se pudo eliminar el documento" />}
      {matchReport.isError && <ApiErrorNotice error={matchReport.error} title="No se pudo vincular el reporte Turnitin" />}

      {document.isPending && (
        <div className="documents-empty-state" role="status" aria-live="polite">
          <span className="state-indicator is-animated" />
          <span>Cargando los metadatos…</span>
        </div>
      )}

      {record && (
        <>
          <section className="document-summary-card" aria-label="Estado del procesamiento">
            <div className="document-summary-main">
              <span className="document-large-icon"><Icon name="file" size={22} /></span>
              <div>
                <span className={statusClass(record.status)}>{statusLabel(record.status)}</span>
                <h2>{record.originalName}</h2>
                <p>{record.extension.toUpperCase()} · {formatBytes(record.sizeBytes)} · Actualizado {formatDate(record.updatedAt)}</p>
              </div>
            </div>
            {isProcessing && <p className="processing-inline" role="status"><span className="state-indicator is-animated" /> El backend está procesando el archivo. Esta vista se actualizará automáticamente.</p>}
            {record.status === 'EXTRACTED' && <p className="document-success-note"><Icon name="check" size={15} /> Extracción de texto completada.</p>}
            {record.status === 'OCR_REQUIRED' && <p className="document-warning-note">Este archivo requiere OCR para continuar. La lectura OCR estará disponible en una fase posterior.</p>}
            {record.status === 'FAILED' && record.extractionError && <p className="document-error-note"><strong>Error de extracción:</strong> {record.extractionError}</p>}
          </section>

          {record.warnings.length > 0 && (
            <section className="document-warnings" aria-labelledby="document-warnings-title">
              <h2 id="document-warnings-title">Avisos del procesamiento</h2>
              <ul>{record.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>
            </section>
          )}

          <section className="document-panel turnitin-attachment-panel" aria-labelledby="attached-turnitin-title">
            <div className="document-panel-heading">
              <div><p className="eyebrow">F002 · GROUND TRUTH</p><h2 id="attached-turnitin-title">Reportes Turnitin vinculados</h2></div>
            </div>
            <p className="turnitin-attachment-copy">La asociación compara el texto del reporte con la versión extraída del documento y registra también conteos y metadatos visibles.</p>
            {turnitinReports.isError && <ApiErrorNotice error={turnitinReports.error} title="No se pudieron cargar los reportes Turnitin" />}
            {attachedTurnitinReports.length > 0 ? (
              <ul className="turnitin-attached-list">{attachedTurnitinReports.map((item) => (
                <li key={item.id}>
                  <span><strong>{item.originalName}</strong><small>{item.reportType} · {item.contentMatchStatus}{item.contentSimilarityRatio !== null ? ` · ${(item.contentSimilarityRatio * 100).toFixed(1)}%` : ''}</small></span>
                  <Link className="button button-quiet" to={`/turnitin-reports/${item.id}`}>Abrir reporte</Link>
                </li>
              ))}</ul>
            ) : !turnitinReports.isPending && <p className="turnitin-no-reports">Todavía no hay reportes vinculados a esta versión.</p>}
            {record.documentVersionId && record.status === 'EXTRACTED' && attachableTurnitinReports.length > 0 && (
              <div className="turnitin-attach-row">
                <label>
                  <span>Selecciona un reporte para comparar</span>
                  <select value={selectedTurnitinReportId} onChange={(event) => setSelectedTurnitinReportId(event.currentTarget.value)}>
                    <option value="">Seleccionar reporte</option>
                    {attachableTurnitinReports.map((item) => <option value={item.id} key={item.id}>{item.originalName} · {item.reportType}</option>)}
                  </select>
                </label>
                <button className="button button-primary" type="button" onClick={() => matchReport.mutate()} disabled={!selectedTurnitinReportId || matchReport.isPending} aria-busy={matchReport.isPending}>
                  {matchReport.isPending ? 'Comparando…' : 'Vincular y comparar'}
                </button>
              </div>
            )}
            {record.status !== 'EXTRACTED' && <p className="turnitin-caution">La comparación estará disponible cuando la extracción del documento termine.</p>}
            {turnitinReports.data?.items.length === 0 && <p className="turnitin-caution"><Link to="/turnitin-reports">Importa un reporte Turnitin</Link> para vincularlo a este documento.</p>}
          </section>

          <div className="document-detail-grid">
            <section className="document-panel metadata-panel" aria-labelledby="metadata-title">
              <div className="document-panel-heading">
                <div><p className="eyebrow">INFORMACIÓN DEL ARCHIVO</p><h2 id="metadata-title">Metadatos</h2></div>
              </div>
              <dl className="metadata-list">
                <div><dt>Nombre original</dt><dd>{record.originalName}</dd></div>
                <div><dt>Formato</dt><dd>{record.extension.toUpperCase()} <span className="metadata-secondary">({record.mimeType || 'tipo no indicado'})</span></dd></div>
                <div><dt>Tamaño</dt><dd>{formatBytes(record.sizeBytes)}</dd></div>
                <div><dt>Páginas</dt><dd>{record.pageCount ?? (record.extension === 'pdf' ? 'Pendiente' : 'No aplica')}</dd></div>
                <div><dt>Palabras</dt><dd>{record.wordCount?.toLocaleString('es-PE') ?? 'Pendiente'}</dd></div>
                <div><dt>Caracteres</dt><dd>{record.characterCount?.toLocaleString('es-PE') ?? 'Pendiente'}</dd></div>
                <div><dt>Subido</dt><dd><time dateTime={record.createdAt}>{formatDate(record.createdAt)}</time></dd></div>
                <div className="metadata-hash"><dt>SHA-256</dt><dd title={record.sha256}>{record.sha256}</dd></div>
                <div><dt>OCR</dt><dd>{record.requiresOcr ? 'Requerido' : 'No requerido'}</dd></div>
              </dl>
            </section>

            <section className="document-panel preview-panel" aria-labelledby="preview-title">
              <div className="document-panel-heading preview-heading">
                <div><p className="eyebrow">CONTENIDO EXTRAÍDO</p><h2 id="preview-title">Vista previa</h2></div>
                {record.status === 'EXTRACTED' && (
                  <button className="button button-quiet" type="button" onClick={() => setShowFullText((value) => !value)} aria-expanded={showFullText}>
                    {showFullText ? 'Ocultar texto completo' : 'Cargar texto completo'}
                  </button>
                )}
              </div>

              {record.textPreview ? (
                <div className="document-preview-text">{record.textPreview}</div>
              ) : (
                <div className="document-preview-empty">
                  {record.status === 'EXTRACTED' ? 'El backend no devolvió una vista previa para este documento.' : 'La vista previa aparecerá cuando termine la extracción del texto.'}
                </div>
              )}

              {showFullText && (
                <div className="full-text-region">
                  {text.isPending && <p className="full-text-status" role="status">Cargando texto completo…</p>}
                  {text.isError && <ApiErrorNotice error={text.error} title="No se pudo cargar el texto completo" />}
                  {text.data && (
                    <>
                      <p className="full-text-meta">{text.data.wordCount.toLocaleString('es-PE')} palabras · {text.data.characterCount.toLocaleString('es-PE')} caracteres</p>
                      <div className="document-full-text">{text.data.text || 'No se encontró texto extraído.'}</div>
                    </>
                  )}
                </div>
              )}
            </section>
          </div>

          <section className="analysis-coming-soon" aria-label="Análisis académico">
            <span className="analysis-coming-icon"><Icon name="spark" size={18} /></span>
            <span><strong>Análisis académico</strong><small>Próximamente · Esta fase se centra en recibir y extraer texto de documentos.</small></span>
            <span className="coming-soon-tag">Próximamente</span>
          </section>
        </>
      )}
    </div>
  )
}
