import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { listTurnitinReports, turnitinQueryKeys, uploadTurnitinReport } from '../../api/turnitin'
import { ApiErrorNotice } from '../documents/ApiErrorNotice'
import { MAX_TURNITIN_REPORT_MB } from '../documents/upload-limits'

function reportTypeLabel(type: string) {
  if (type === 'AI_WRITING') return 'Escritura con IA'
  if (type === 'SIMILARITY') return 'Similitud'
  return 'Sin identificar'
}

function reportStatusLabel(status: string) {
  const labels: Record<string, string> = {
    UPLOADED: 'Subido', PROCESSING: 'Procesando', PARSED: 'Procesado',
    PARTIAL: 'Parcial', FAILED: 'Fallido', OCR_REQUIRED: 'OCR requerido',
  }
  return labels[status] ?? status
}

function primaryScore(report: { scores: { aiWriting: { raw: string | null }; similarity: { raw: string | null } } }) {
  return report.scores.aiWriting.raw ?? report.scores.similarity.raw ?? '—'
}

export function TurnitinReportsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const reports = useQuery({
    queryKey: turnitinQueryKeys.list(1, 20),
    queryFn: () => listTurnitinReports(1, 20),
    retry: 1,
  })
  const upload = useMutation({
    mutationFn: uploadTurnitinReport,
    onSuccess: (report) => {
      void queryClient.invalidateQueries({ queryKey: turnitinQueryKeys.all })
      navigate(`/turnitin-reports/${report.id}`)
    },
  })

  function chooseFile(selected: File | undefined) {
    setLocalError(null)
    upload.reset()
    setFile(selected ?? null)
    if (selected && selected.size > MAX_TURNITIN_REPORT_MB * 1024 * 1024) {
      setLocalError(`El PDF supera el límite de ${MAX_TURNITIN_REPORT_MB} MB.`)
    }
  }

  function submit() {
    if (!file) return
    if (file.size > MAX_TURNITIN_REPORT_MB * 1024 * 1024) {
      setLocalError(`El PDF supera el límite de ${MAX_TURNITIN_REPORT_MB} MB.`)
      return
    }
    upload.mutate(file)
  }

  return (
    <div className="dashboard-main turnitin-main">
      <div className="page-heading documents-page-heading">
        <div>
          <p className="eyebrow">LECTURA DE INFORMES</p>
          <h1>Reportes Turnitin</h1>
          <p className="page-subtitle">Interpreta los datos visibles de reportes de escritura con IA y similitud.</p>
        </div>
        <Link className="button button-quiet" to="/documents">Ver documentos</Link>
      </div>

      <section className="document-panel turnitin-upload-panel" aria-labelledby="turnitin-upload-title">
        <div className="document-panel-heading">
          <div>
            <p className="eyebrow">IMPORTACIÓN LOCAL</p>
            <h2 id="turnitin-upload-title">Sube un reporte PDF</h2>
          </div>
        </div>
        <div className="turnitin-upload-row">
          <label className="turnitin-file-input">
            <span>Selecciona un reporte PDF</span>
            <input type="file" accept="application/pdf,.pdf" onChange={(event) => chooseFile(event.currentTarget.files?.[0])} disabled={upload.isPending} />
          </label>
          <button className="button button-primary" type="button" onClick={submit} disabled={!file || upload.isPending || Boolean(localError)} aria-busy={upload.isPending}>
            {upload.isPending ? 'Leyendo reporte…' : 'Subir y analizar'}
          </button>
        </div>
        <p className="turnitin-privacy-copy">El PDF se procesa en este entorno local. Máximo {MAX_TURNITIN_REPORT_MB} MB. No se busca ni abre ninguna fuente citada.</p>
        {file && <p className="turnitin-selected-file">{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB</p>}
        {localError && <p className="turnitin-inline-error" role="alert">{localError}</p>}
        {upload.isError && <ApiErrorNotice error={upload.error} title="No se pudo procesar el reporte" />}
      </section>

      <section className="documents-section turnitin-list-section" aria-labelledby="turnitin-list-title">
        <div className="documents-section-heading">
          <div>
            <p className="eyebrow">BIBLIOTECA</p>
            <h2 id="turnitin-list-title">Reportes recientes</h2>
          </div>
          <span className="documents-section-meta">{reports.data?.total ?? 0} reportes</span>
        </div>

        {reports.isError && <ApiErrorNotice error={reports.error} title="No se pudieron cargar los reportes" />}
        {reports.isPending && <div className="documents-empty-state" role="status"><span className="state-indicator is-animated" /><span>Cargando reportes…</span></div>}
        {reports.data?.items.length === 0 && (
          <div className="documents-empty-state">
            <strong>Aún no hay reportes</strong>
            <span>Los PDFs que importes aparecerán aquí con sus resultados y advertencias.</span>
          </div>
        )}
        {reports.data && reports.data.items.length > 0 && (
          <ul className="turnitin-report-list">
            {reports.data.items.map((report) => (
              <li className="turnitin-report-row" key={report.id}>
                <span className="turnitin-report-icon" aria-hidden="true">T</span>
                <span className="turnitin-report-name">
                  <Link to={`/turnitin-reports/${report.id}`} title={report.originalName}>{report.originalName}</Link>
                  <small>{reportTypeLabel(report.reportType)} · {report.wordCount?.toLocaleString('es-PE') ?? '—'} palabras · {report.sourceCount} fuentes · {report.segmentCount} segmentos</small>
                </span>
                <span className={`turnitin-status turnitin-status-${report.status.toLowerCase().replace('_', '-')}`}>{reportStatusLabel(report.status)}</span>
                <span className="turnitin-score">{primaryScore(report)}</span>
                <Link className="document-open-link" to={`/turnitin-reports/${report.id}`} aria-label={`Abrir reporte ${report.originalName}`}>›</Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
