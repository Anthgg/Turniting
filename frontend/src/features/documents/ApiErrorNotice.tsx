import { errorPresentation } from './document-utils'

export function ApiErrorNotice({ error, title = 'No se pudo completar la solicitud' }: { error: unknown; title?: string }) {
  const detail = errorPresentation(error)

  return (
    <div className="api-error" role="alert">
      <div>
        <strong>{title}</strong>
        <p>{detail.message}</p>
        <code>{detail.code}</code>
      </div>
    </div>
  )
}
