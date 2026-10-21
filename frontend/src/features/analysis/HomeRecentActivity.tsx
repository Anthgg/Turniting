import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { listReports } from '../../api/reports'
import { loadAnalysisHistory } from './analysis-history-data'
import './AnalysisHistoryPage.css'

const reportTypeLabels: Record<string, string> = {
  AI_REPORT: 'Reporte de escritura',
  AI_ORIGINAL_REVIEW: 'Revisión sobre original',
  AI_PARAGRAPH_TECHNICAL: 'Detalle por segmentos',
  SIMILARITY_REPORT: 'Reporte de similitud',
}

function reportStatusLabel(status: string) {
  const labels: Record<string, string> = {
    GENERATING: 'Generando',
    AVAILABLE: 'Disponible',
    FAILED: 'Fallido',
    ERROR: 'Error',
    EXPIRED: 'Expirado',
    DELETED: 'Eliminado',
  }
  return labels[status] ?? 'Estado desconocido'
}

function dateLabel(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Fecha no disponible' : new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium' }).format(date)
}

export function HomeRecentActivity() {
  const latestAnalysis = useQuery({
    queryKey: ['home', 'latest-analysis'],
    queryFn: () => loadAnalysisHistory(1, 5),
    staleTime: 15_000,
    retry: 1,
  })
  const recentReports = useQuery({
    queryKey: ['home', 'recent-reports'],
    queryFn: () => listReports({ page: 1, pageSize: 3 }),
    staleTime: 15_000,
    retry: 1,
  })
  const latest = latestAnalysis.data?.entries[0]

  return (
    <section className="home-highlights" aria-label="Último análisis y reportes recientes">
      <article className="home-highlight-card">
        <div className="home-highlight-heading">
          <h2>Último análisis</h2>
          <Link className="button button-quiet" to="/history">Historial</Link>
        </div>
        {latestAnalysis.isPending && <p className="home-highlight-empty" role="status">Cargando el último análisis…</p>}
        {latestAnalysis.isError && <p className="home-highlight-empty" role="alert">No se pudo cargar el último análisis.</p>}
        {latest ? (
          <div className="home-latest-analysis">
            <Link to={`/documents/${latest.document.id}`} title={latest.document.originalName}>
              <strong>{latest.document.originalName}</strong>
              <small>{dateLabel(latest.run.createdAt)} · {latest.run.status === 'COMPLETED' ? 'Completado' : latest.run.status === 'FAILED' ? 'Fallido' : 'En proceso'}</small>
            </Link>
            <strong className="home-highlight-score">
              {latest.run.documentScore === null ? '—' : `${(latest.run.documentScore * 100).toFixed(1)} %`}
            </strong>
          </div>
        ) : latestAnalysis.data && (
          <div className="home-highlight-empty">
            Aún no hay análisis documentales. <Link to="/documents">Analizar documento</Link>
          </div>
        )}
      </article>

      <article className="home-highlight-card">
        <div className="home-highlight-heading">
          <h2>Reportes recientes</h2>
          <Link className="button button-quiet" to="/reports">Ver reportes</Link>
        </div>
        {recentReports.isPending && <p className="home-highlight-empty" role="status">Cargando reportes…</p>}
        {recentReports.isError && <p className="home-highlight-empty" role="alert">No se pudieron cargar los reportes.</p>}
        {recentReports.data?.items.length === 0 && <p className="home-highlight-empty">Aún no hay reportes generados.</p>}
        {recentReports.data?.items.map((report) => (
          <div className="home-recent-report" key={report.id}>
            <Link to="/reports" title={report.documentName ?? report.filename}>
              <strong>{report.documentName ?? report.filename}</strong>
              <small>{reportTypeLabels[report.type] ?? 'Reporte'} · {dateLabel(report.generatedAt)}</small>
            </Link>
            <span className={`report-status report-status-${report.status.toLowerCase()}`}>{reportStatusLabel(report.status)}</span>
          </div>
        ))}
      </article>
    </section>
  )
}
