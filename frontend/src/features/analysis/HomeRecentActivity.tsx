import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { listReports } from '../../api/reports'
import { TurnitingFeedback } from '../../components/TurnitingFeedback'
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
        {latestAnalysis.isPending && <TurnitingFeedback state="thinking" title="Buscando el último análisis" className="home-highlight-empty" layout="inline" />}
        {latestAnalysis.isError && <TurnitingFeedback state="network-error" title="No se pudo cargar el último análisis" className="home-highlight-empty" layout="inline" />}
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
          <TurnitingFeedback state="empty" title="Aún no hay análisis documentales" className="home-highlight-empty" layout="inline">
            <Link to="/documents">Analizar documento</Link>
          </TurnitingFeedback>
        )}
      </article>

      <article className="home-highlight-card">
        <div className="home-highlight-heading">
          <h2>Reportes recientes</h2>
          <Link className="button button-quiet" to="/reports">Ver reportes</Link>
        </div>
        {recentReports.isPending && <TurnitingFeedback state="reading" title="Leyendo reportes recientes" className="home-highlight-empty" layout="inline" />}
        {recentReports.isError && <TurnitingFeedback state="network-error" title="No se pudieron cargar los reportes" className="home-highlight-empty" layout="inline" />}
        {recentReports.data?.items.length === 0 && <TurnitingFeedback state="empty" title="Aún no hay reportes generados" className="home-highlight-empty" layout="inline" />}
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
