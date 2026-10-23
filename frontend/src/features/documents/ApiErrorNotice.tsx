import { errorPresentation } from './document-utils'
import { TurnitingFeedback } from '../../components/TurnitingFeedback'

export function ApiErrorNotice({ error, title = 'No se pudo completar la solicitud' }: { error: unknown; title?: string }) {
  const detail = errorPresentation(error)

  return (
    <TurnitingFeedback state={detail.code === 'NETWORK_ERROR' ? 'network-error' : 'error'} title={title} description={detail.message} className="api-error" layout="inline">
      <code>{detail.code}</code>
    </TurnitingFeedback>
  )
}
