import type { UseQueryResult } from '@tanstack/react-query'
import type { HealthResponse, HealthService } from '../api/health'
import { Icon, type IconName } from './Icon'

interface ServiceStatusCardProps {
  title: string
  description: string
  endpoint: string
  icon: IconName
  service: HealthService
  query: UseQueryResult<HealthResponse, Error>
}

function isServiceHealthy(service: HealthService, data?: HealthResponse) {
  if (!data || data.status.toLowerCase() !== 'ok') return false
  if (service === 'database') return data.database?.toLowerCase() === 'connected'
  if (service === 'ai') return data.aiService?.toLowerCase() === 'connected'
  return true
}

function formatCheckedAt(timestamp: number) {
  if (!timestamp) return 'Comprobando conexión'
  return `Consultado a las ${new Intl.DateTimeFormat('es-PE', { hour: '2-digit', minute: '2-digit' }).format(timestamp)}`
}

export function ServiceStatusCard({ title, description, endpoint, icon, service, query }: ServiceStatusCardProps) {
  const healthy = isServiceHealthy(service, query.data)
  const state = query.isPending ? 'checking' : query.isError ? 'offline' : healthy ? 'online' : 'offline'
  const stateLabel = state === 'checking' ? 'Comprobando' : state === 'online' ? 'Operativo' : 'Sin conexión'
  const detail = query.isError
    ? 'No se pudo consultar este servicio.'
    : query.isSuccess && !healthy
      ? 'El servicio respondió con un estado no disponible.'
      : description

  return (
    <article className="service-card" aria-labelledby={`service-${service}`}>
      <div className="service-card-top">
        <span className={`service-icon service-icon-${service}`}><Icon name={icon} size={19} /></span>
        <span className={`status-pill status-${state}`} role="status" aria-live="polite">
          <span className="status-dot" />
          {stateLabel}
        </span>
      </div>
      <h3 id={`service-${service}`}>{title}</h3>
      <p className="service-description">{detail}</p>
      <div className="service-card-bottom">
        <code>{endpoint}</code>
        <span>{formatCheckedAt(query.dataUpdatedAt)}</span>
      </div>
    </article>
  )
}
