import { useQueries, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { analysisQueryKeys, listDocumentAnalyses } from '../../api/analysis'
import { documentQueryKeys, listDocuments, type DocumentSummary } from '../../api/documents'
import { ANALYZER_LABEL } from '../analysis/analysis-utils'
import { Icon } from '../../components/Icon'
import { ApiErrorNotice } from './ApiErrorNotice'
import { DocumentUpload } from './DocumentUpload'
import { formatBytes, formatDate, statusClass, statusLabel } from './document-utils'
import './DocumentListPage.css'

const PAGE_SIZE = 10

function documentAction(status: DocumentSummary['status']) {
  if (status === 'EXTRACTED') return { label: 'Analizar documento', primary: true }
  if (status === 'OCR_REQUIRED') return { label: 'Revisar OCR', primary: false }
  if (status === 'FAILED') return { label: 'Revisar documento', primary: false }
  return { label: 'Ver estado', primary: false }
}

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
  const analysisQueries = useQueries({
    queries: (pageData?.items ?? []).map((document) => ({
      queryKey: analysisQueryKeys.documentAnalyses(document.id),
      queryFn: () => listDocumentAnalyses(document.id),
      enabled: document.status === 'EXTRACTED',
      staleTime: 30_000,
      retry: 0,
    })),
  })

  return (
    <div className="dashboard-main documents-main documents-library">
      <header className="documents-library-heading">
        <div className="documents-library-title">
          <p className="eyebrow">BIBLIOTECA ACADÉMICA</p>
          <h1>Documentos</h1>
          <p className="page-subtitle">Sube tus archivos y abre los documentos listos para analizar.</p>
        </div>
        <Link className="button button-quiet documents-home-link" to="/">
          <Icon name="arrow-right" size={16} className="back-arrow" />
          <span>Volver al inicio</span>
        </Link>
      </header>

      <section className="documents-upload-panel" aria-labelledby="documents-upload-heading">
        <div className="documents-upload-heading">
          <div>
            <p className="eyebrow">AÑADIR A LA BIBLIOTECA</p>
            <h2 id="documents-upload-heading">Subir un documento</h2>
          </div>
          <span className="documents-upload-formats">PDF · DOCX · TXT · PNG · JPEG</span>
        </div>
        <DocumentUpload />
      </section>

      <section className="documents-section documents-library-section" aria-labelledby="documents-list-title">
        <div className="documents-library-toolbar">
          <div>
            <p className="eyebrow">ARCHIVOS EN EL ENTORNO</p>
            <h2 id="documents-list-title">Tus documentos</h2>
          </div>
          <div className="documents-library-controls">
            <span className="documents-library-count" aria-live="polite" aria-atomic="true">
              {pageData && `${pageData.total} ${pageData.total === 1 ? 'documento' : 'documentos'}`}
            </span>
            <button
              className="icon-button documents-refresh-button"
              type="button"
              onClick={() => void documents.refetch()}
              disabled={documents.isFetching}
              aria-label="Actualizar lista de documentos"
              aria-busy={documents.isFetching}
            >
              <span aria-hidden="true">
                <Icon name="refresh" size={16} className={documents.isFetching ? 'is-spinning' : undefined} />
              </span>
            </button>
          </div>
        </div>

        {documents.isError && (
          <div className="documents-load-error">
            <ApiErrorNotice error={documents.error} title="No se pudieron cargar los documentos" />
            <button className="button button-quiet" type="button" onClick={() => void documents.refetch()} disabled={documents.isFetching}>
              Reintentar
            </button>
          </div>
        )}

        {documents.isPending && (
          <div className="documents-library-state" role="status" aria-live="polite">
            <span className="documents-loading-mark" aria-hidden="true" />
            <span>Cargando documentos…</span>
          </div>
        )}

        {pageData && pageData.items.length === 0 && (
          <div className="documents-library-empty" role="status" aria-live="polite">
            <span className="documents-empty-icon" aria-hidden="true"><Icon name="file" size={20} /></span>
            <strong>Aún no hay documentos</strong>
            <span>Sube un archivo para seguir aquí su procesamiento y análisis.</span>
          </div>
        )}

        {pageData && pageData.items.length > 0 && (
          <>
            <ul className="documents-library-list" aria-label="Lista de documentos">
              {pageData.items.map((document, index) => {
                const action = documentAction(document.status)
                const detailHref = `/documents/${document.id}`
                const fileType = document.extension?.toUpperCase() || 'ARCHIVO'
                const analysisQuery = analysisQueries[index]
                const latestRun = [...(analysisQuery?.data?.items ?? [])]
                  .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]
                const runScore = latestRun?.documentScore !== null && latestRun?.documentScore !== undefined
                  ? latestRun.documentScore * 100
                  : latestRun?.documentScorePercent

                return (
                  <li className="documents-library-item" key={document.id}>
                    <article className="documents-library-card">
                      <span className="documents-library-file-icon" aria-hidden="true">
                        <Icon name="file" size={19} />
                      </span>
                      <div className="documents-library-document">
                        <div className="documents-library-document-heading">
                          <h3>
                            <Link className="documents-library-document-link" to={detailHref} title={document.originalName}>
                              {document.originalName}
                            </Link>
                          </h3>
                          <span className={statusClass(document.status)}>{statusLabel(document.status)}</span>
                        </div>
                        <div className="documents-library-metadata">
                          <span>{fileType}</span>
                          <span aria-hidden="true">·</span>
                          <span>{formatBytes(document.sizeBytes)}</span>
                          <span className="documents-library-date">
                            <span aria-hidden="true">·</span>
                            <time dateTime={document.createdAt}>{formatDate(document.createdAt)}</time>
                          </span>
                        </div>
                      </div>
                      <div className="documents-library-analysis" aria-label="Último análisis">
                        {document.status !== 'EXTRACTED' ? (
                          <span className="documents-analysis-muted">El análisis estará disponible al terminar la extracción</span>
                        ) : analysisQuery?.isPending ? (
                          <span className="documents-analysis-muted" role="status">Consultando análisis…</span>
                        ) : analysisQuery?.isError ? (
                          <span className="documents-analysis-muted">No se pudo consultar el análisis</span>
                        ) : !latestRun ? (
                          <span className="documents-analysis-muted">Aún no hay análisis</span>
                        ) : latestRun.status !== 'COMPLETED' ? (
                          <span className="documents-analysis-muted">
                            {latestRun.status === 'PENDING' || latestRun.status === 'RUNNING' ? 'Análisis en curso' : 'El último análisis no se completó'}
                          </span>
                        ) : (
                          <>
                            <span className="documents-analysis-score">
                              {runScore === null || runScore === undefined
                                ? 'Sin puntaje'
                                : `${runScore.toLocaleString('es-PE', { maximumFractionDigits: 1 })} %`}
                            </span>
                            <span>{latestRun.evaluatedSegments ?? latestRun.scoredSegments} evaluados</span>
                            {latestRun.flaggedSegments !== undefined && <span>{latestRun.flaggedSegments} señalados</span>}
                            <span className="documents-analysis-model">{ANALYZER_LABEL[latestRun.analyzerMode] ?? 'Analizador registrado'}</span>
                          </>
                        )}
                      </div>
                      <div className="documents-library-card-action">
                        <Link
                          className={`button ${action.primary ? 'button-primary' : 'button-quiet'} documents-library-open-link`}
                          to={detailHref}
                          aria-label={`${action.label}: ${document.originalName}`}
                        >
                          <span>{action.label}</span>
                          <Icon name="arrow-right" size={15} />
                        </Link>
                      </div>
                    </article>
                  </li>
                )
              })}
            </ul>

            <nav className="pagination documents-library-pagination" aria-label="Paginación de documentos">
              <span>Página {pageData.page} de {totalPages || 1}</span>
              <div>
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                  disabled={!canGoBack || documents.isFetching}
                >
                  Anterior
                </button>
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => setPage((value) => value + 1)}
                  disabled={!canGoForward || documents.isFetching}
                >
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
