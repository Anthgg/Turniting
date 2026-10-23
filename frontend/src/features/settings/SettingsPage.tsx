import { useQuery } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { ServiceStatusCard } from '../../components/ServiceStatusCard'
import { TurnitingFeedback } from '../../components/TurnitingFeedback'
import { getHealth } from '../../api/health'
import type { HealthService } from '../../api/health'

const serviceEndpoints: Record<HealthService, string> = {
  backend: '/api/health',
  database: '/api/health/db',
  ai: '/api/health/ai',
}

export function SettingsPage() {
  const backend = useQuery({
    queryKey: ['health', 'backend'],
    queryFn: () => getHealth('backend'),
    refetchInterval: 30_000,
    retry: 1,
  })
  const database = useQuery({
    queryKey: ['health', 'database'],
    queryFn: () => getHealth('database'),
    refetchInterval: 30_000,
    retry: 1,
  })
  const ai = useQuery({
    queryKey: ['health', 'ai'],
    queryFn: () => getHealth('ai'),
    refetchInterval: 30_000,
    retry: 1,
  })

  const isRefreshing = backend.isFetching || database.isFetching || ai.isFetching
  const initialHealthCheck = backend.isPending || database.isPending || ai.isPending
  const hasServiceIssue = backend.isError || database.isError || ai.isError
    || backend.data?.status.toLowerCase() !== 'ok'
    || database.data?.status.toLowerCase() !== 'ok'
    || database.data?.database?.toLowerCase() !== 'connected'
    || ai.data?.status.toLowerCase() !== 'ok'
    || ai.data?.aiService?.toLowerCase() !== 'connected'

  async function refreshServices() {
    await Promise.all([backend.refetch(), database.refetch(), ai.refetch()])
  }

  return (
    <div className="dashboard-main settings-main">
      <div className="page-heading">
        <div>
          <p className="eyebrow">CONFIGURACIÓN</p>
          <h1>Estado técnico</h1>
          <p className="page-subtitle">Conectividad de los servicios que usa este entorno local.</p>
        </div>
      </div>

      <section className="health-section open-section" aria-labelledby="health-title">
        <div className="section-heading settings-section-heading">
          <div>
            <p className="eyebrow">SERVICIOS LOCALES</p>
            <h2 id="health-title">Conexiones</h2>
          </div>
          <div className="settings-health-actions">
            <span className="auto-refresh"><span className="live-pulse" /> Actualización cada 30 s</span>
            <button
              className="button button-quiet refresh-button"
              type="button"
              onClick={() => void refreshServices()}
              aria-label="Actualizar estado de los servicios"
              aria-busy={isRefreshing}
            >
              <Icon name="refresh" size={15} className={isRefreshing ? 'is-spinning' : undefined} />
              <span>Actualizar</span>
            </button>
          </div>
        </div>
        {initialHealthCheck && <TurnitingFeedback state="thinking" title="Comprobando servicios" description="Revisando backend, base de datos y servicio de IA…" className="settings-health-feedback" layout="inline" />}
        {!initialHealthCheck && hasServiceIssue && <TurnitingFeedback state="warning" title="Hay servicios que requieren atención" description="Consulta cada tarjeta para ver su estado y última respuesta." className="settings-health-feedback" layout="inline" />}
        {!initialHealthCheck && !hasServiceIssue && <TurnitingFeedback state="success" title="Servicios operativos" description="Backend, base de datos y servicio de IA respondieron correctamente." className="settings-health-feedback" layout="inline" />}
        <div className="service-grid">
          <ServiceStatusCard title="Backend API" description="API principal de la plataforma" endpoint={serviceEndpoints.backend} icon="server" service="backend" query={backend} />
          <ServiceStatusCard title="Base de datos" description="Conexión con PostgreSQL" endpoint={serviceEndpoints.database} icon="database" service="database" query={database} />
          <ServiceStatusCard title="Servicio de IA" description="Inferencia local de modelos" endpoint={serviceEndpoints.ai} icon="brain" service="ai" query={ai} />
        </div>
      </section>

      <footer className="page-footer settings-project-history">
        <span>Turniting · Análisis académico independiente</span>
        <span>F001 Documentos · F002 Reportes · F003 OCR · F004 Datasets · F005/F006.2 Research UI</span>
      </footer>
    </div>
  )
}
