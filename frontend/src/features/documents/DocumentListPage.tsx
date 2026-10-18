import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { documentQueryKeys, listDocuments } from '../../api/documents'
import { Icon } from '../../components/Icon'
import { DocumentUpload } from './DocumentUpload'
import { ApiErrorNotice } from './ApiErrorNotice'
import { formatBytes, formatDate, statusClass, statusLabel } from './document-utils'

const PAGE_SIZE = 10

export function DocumentListPage() {
  const [page, setPage] = useState(1)
  const documents = useQuery({
    queryKey: documentQueryKeys.list(page, PAGE_SIZE),
    queryFn: () => listDocuments(page, PAGE_SIZE),
    retry: 1,
  })

  const pageData = documents.data
  const totalPages = pageData?.totalPages ?? 0
  const canGoBack = page > 1
  const canGoForward = pageData ? page < pageData.totalPages : false

  return (
    <div className="dashboard-main documents-main">
      <div className="page-heading documents-page-heading">
        <div>
          <p className="eyebrow">BIBLIOTECA ACADÉMICA</p>
          <h1>Documentos</h1>
          <p className="page-subtitle">Sube un archivo y sigue su extracción y análisis desde un solo lugar.</p>
        </div>
        <div className="page-heading-actions">
          <Link className="button button-quiet" to="/">
            <Icon name="arrow-right" size={16} className="back-arrow" />
            <span>Volver al inicio</span>
          </Link>
        </div>
      </div>

      <DocumentUpload />

      <section className="documents-section open-section" aria-labelledby="documents-list-title">
        <div className="documents-section-heading">
          <div>
            <p className="eyebrow">ARCHIVOS EN EL ENTORNO</p>
            <h2 id="documents-list-title">Tus documentos</h2>
          </div>
          <div className="documents-section-meta">
            {pageData && <span>{pageData.total} {pageData.total === 1 ? 'documento' : 'documentos'}</span>}
            <button
              className="icon-button"
              type="button"
              onClick={() => void documents.refetch()}
              disabled={documents.isFetching}
              aria-label="Actualizar lista de documentos"
              aria-busy={documents.isFetching}
            >
              <Icon name="refresh" size={16} className={documents.isFetching ? 'is-spinning' : undefined} />
            </button>
          </div>
        </div>

        {documents.isError && <ApiErrorNotice error={documents.error} title="No se pudieron cargar los documentos" />}

        {documents.isPending && (
          <div className="documents-empty-state" role="status" aria-live="polite">
            <span className="state-indicator is-animated" />
            <span>Cargando documentos…</span>
          </div>
        )}

        {pageData && pageData.items.length === 0 && (
          <div className="documents-empty-state">
            <span className="empty-file-icon"><Icon name="file" size={20} /></span>
            <strong>Aún no hay documentos</strong>
            <span>Los archivos que subas aparecerán aquí con su estado de procesamiento.</span>
          </div>
        )}

        {pageData && pageData.items.length > 0 && (
          <>
            <div className="finder-table-wrap">
              <table className="finder-table" aria-label="Documentos subidos">
                <thead>
                  <tr>
                    <th>Documento</th>
                    <th>Tipo</th>
                    <th>Tamaño</th>
                    <th>Estado</th>
                    <th>Fecha</th>
                    <th className="finder-col-action">Abrir</th>
                  </tr>
                </thead>
                <tbody>
                  {pageData.items.map((document) => (
                    <tr className="document-list-row" key={document.id}>
                      <td className="finder-col-name document-list-name">
                        <Link to={`/documents/${document.id}`} title={document.originalName}>
                          <Icon name="file" size={16} />
                          <span>{document.originalName}</span>
                        </Link>
                      </td>
                      <td className="finder-col-mono">{document.extension?.toUpperCase() || 'ARCHIVO'}</td>
                      <td className="finder-col-mono">{formatBytes(document.sizeBytes)}</td>
                      <td>
                        <span className={statusClass(document.status)}>{statusLabel(document.status)}</span>
                      </td>
                      <td className="finder-col-date">
                        <time className="document-list-date" dateTime={document.createdAt}>{formatDate(document.createdAt)}</time>
                      </td>
                      <td className="finder-col-action">
                        <Link className="document-open-link finder-row-action" to={`/documents/${document.id}`} aria-label={`Abrir ${document.originalName}`}>
                          <span>Detalle</span>
                          <Icon name="arrow-right" size={15} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <nav className="pagination" aria-label="Paginación de documentos">
              <span>Página {pageData.page} de {totalPages || 1}</span>
              <div>
                <button className="button button-quiet" type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={!canGoBack || documents.isFetching}>
                  Anterior
                </button>
                <button className="button button-quiet" type="button" onClick={() => setPage((value) => value + 1)} disabled={!canGoForward || documents.isFetching}>
                  Siguiente
                </button>
              </div>
            </nav>
          </>
        )}
      </section>
    </div>
  )
}
