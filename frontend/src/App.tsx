import { useQuery } from '@tanstack/react-query'
import { Link, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import './App.css'
import { documentQueryKeys, getDocument, listDocuments } from './api/documents'
import { getHealth } from './api/health'
import type { HealthService } from './api/health'
import { Icon } from './components/Icon'
import { ServiceStatusCard } from './components/ServiceStatusCard'
import { ComparePage } from './features/analysis/ComparePage'
import { ModelsPage } from './features/analysis/ModelsPage'
import { DocumentDetailPage } from './features/documents/DocumentDetailPage'
import { DocumentListPage } from './features/documents/DocumentListPage'
import { formatBytes, formatDate, statusClass, statusLabel } from './features/documents/document-utils'
import { DatasetDetailPage } from './features/datasets/DatasetDetailPage'
import { DatasetsPage } from './features/datasets/DatasetsPage'
import { TurnitinReportDetailPage } from './features/turnitin/TurnitinReportDetailPage'
import { TurnitinReportsPage } from './features/turnitin/TurnitinReportsPage'
import { MAX_UPLOAD_MB } from './features/documents/upload-limits'

const serviceEndpoints: Record<HealthService, string> = {
  backend: '/api/health',
  database: '/api/health/db',
  ai: '/api/health/ai',
}

export function WorkspaceLayout() {
  const location = useLocation()
  const docMatch = /^\/documents\/([^/]+)$/.exec(location.pathname)
  const activeDocId = docMatch ? decodeURIComponent(docMatch[1]) : null

  const recentDocs = useQuery({
    queryKey: documentQueryKeys.list(1, 5),
    queryFn: () => listDocuments(1, 5),
    staleTime: 15_000,
    retry: 1,
  })

  const activeDoc = useQuery({
    queryKey: activeDocId ? documentQueryKeys.detail(activeDocId) : ['documents', 'detail', 'none'],
    queryFn: () => getDocument(activeDocId!),
    enabled: Boolean(activeDocId),
    staleTime: 15_000,
    retry: 1,
  })

  const firstDocId = recentDocs.data?.items[0]?.id ?? null
  const analysisTargetHref = activeDocId
    ? `/documents/${activeDocId}`
    : firstDocId
      ? `/documents/${firstDocId}`
      : '/documents'

  const isAnalysisRoute = Boolean(activeDocId)
  const isDocumentsListRoute = location.pathname === '/documents'

  const section = location.pathname === '/'
    ? 'Inicio'
    : isDocumentsListRoute
      ? 'Documentos'
      : location.pathname.startsWith('/turnitin-reports')
        ? 'Reportes Turnitin'
      : location.pathname.startsWith('/datasets')
        ? 'Datasets'
      : location.pathname.startsWith('/models')
        ? 'Modelos'
      : location.pathname.startsWith('/analysis')
        ? 'Comparar versiones'
      : activeDoc.data?.originalName ?? 'Detalle del documento'

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Saltar al contenido principal</a>

      <header className="topbar">
        <div className="topbar-left">
          <Link className="brand" to="/" aria-label="Turniting, inicio">
            <span className="brand-mark" aria-hidden="true">T</span>
            <span className="brand-name">Turniting</span>
          </Link>
          <span className="topbar-divider" aria-hidden="true" />
          <details className="workspace-selector">
            <summary className="workspace-selector-trigger" aria-label="Espacio de trabajo: Área académica">
              <span>Área académica</span>
              <Icon name="chevron-down" size={13} />
            </summary>
            <div className="workspace-selector-menu" role="menu" aria-label="Espacios de trabajo">
              <div className="workspace-selector-item is-selected" role="menuitem">
                <div>
                  <strong>Área académica</strong>
                  <small>Investigación local · F006.2</small>
                </div>
                <Icon name="check" size={14} />
              </div>
              <div className="workspace-selector-footer">
                <span>Modelos V2, V3 y Ensemble activos localmente</span>
              </div>
            </div>
          </details>
        </div>

        <nav className="breadcrumbs" aria-label="Ubicación actual">
          {isAnalysisRoute ? (
            <>
              <Link to="/documents">Documentos</Link>
              <Icon name="chevron-right" size={13} />
              <span className="breadcrumb-current" aria-current="page" title={section}>{section}</span>
            </>
          ) : (
            <>
              <Link to="/">Espacio de trabajo</Link>
              <Icon name="chevron-right" size={13} />
              <span className="breadcrumb-current" aria-current="page">{section}</span>
            </>
          )}
        </nav>

        <div className="topbar-right">
          <div className="topbar-meta" title="Servicios conectados en entorno local">
            <span className="environment-dot" aria-hidden="true" />
            <span>Entorno local</span>
          </div>
          <Link className="button button-quiet topbar-upload-btn" to="/documents">
            <Icon name="upload" size={14} />
            <span>Subir</span>
          </Link>
        </div>
      </header>

      <div className="main-shell">
        <main id="main-content" className="main-content"><Outlet /></main>
      </div>

      <nav className="bottom-dock" aria-label="Navegación principal">
        <div className="bottom-dock-inner">
          <NavLink
            to="/"
            end
            className={({ isActive }) => `dock-item${isActive ? ' is-active' : ''}`}
            aria-label="Inicio"
            data-tooltip="Inicio"
          >
            <span className="dock-icon"><Icon name="grid" size={18} /></span>
            <span className="dock-label">Inicio</span>
            <span className="dock-active-dot" aria-hidden="true" />
          </NavLink>

          <NavLink
            to="/documents"
            end
            className={({ isActive }) => `dock-item${isActive ? ' is-active' : ''}`}
            aria-label="Documentos"
            data-tooltip="Documentos"
          >
            <span className="dock-icon"><Icon name="file" size={18} /></span>
            <span className="dock-label">Documentos</span>
            <span className="dock-active-dot" aria-hidden="true" />
          </NavLink>

          <Link
            to={analysisTargetHref}
            className={`dock-item${isAnalysisRoute ? ' is-active' : ''}`}
            aria-label="Análisis IA"
            aria-current={isAnalysisRoute ? 'page' : undefined}
            data-tooltip="Análisis IA"
          >
            <span className="dock-icon"><Icon name="spark" size={18} /></span>
            <span className="dock-label">Análisis IA</span>
            <span className="dock-active-dot" aria-hidden="true" />
          </Link>

          <NavLink
            to="/analysis/compare"
            className={({ isActive }) => `dock-item${isActive ? ' is-active' : ''}`}
            aria-label="Comparar versiones"
            data-tooltip="Comparar versiones"
          >
            <span className="dock-icon"><Icon name="diff" size={18} /></span>
            <span className="dock-label">Comparar</span>
            <span className="dock-active-dot" aria-hidden="true" />
          </NavLink>

          <NavLink
            to="/turnitin-reports"
            className={({ isActive }) => `dock-item${isActive ? ' is-active' : ''}`}
            aria-label="Reportes Turnitin"
            data-tooltip="Reportes Turnitin"
          >
            <span className="dock-icon"><Icon name="layers" size={18} /></span>
            <span className="dock-label">Reportes</span>
            <span className="dock-active-dot" aria-hidden="true" />
          </NavLink>

          <NavLink
            to="/models"
            className={({ isActive }) => `dock-item${isActive ? ' is-active' : ''}`}
            aria-label="Modelos"
            data-tooltip="Modelos"
          >
            <span className="dock-icon"><Icon name="brain" size={18} /></span>
            <span className="dock-label">Modelos</span>
            <span className="dock-active-dot" aria-hidden="true" />
          </NavLink>

          <NavLink
            to="/datasets"
            className={({ isActive }) => `dock-item${isActive ? ' is-active' : ''}`}
            aria-label="Datasets"
            data-tooltip="Datasets"
          >
            <span className="dock-icon"><Icon name="database" size={18} /></span>
            <span className="dock-label">Datasets</span>
            <span className="dock-active-dot" aria-hidden="true" />
          </NavLink>

          <span className="dock-divider" aria-hidden="true" />

          <Link
            to="/documents"
            className="dock-item dock-item-upload"
            aria-label="Subir nuevo documento"
            data-tooltip="Subir documento"
          >
            <span className="dock-icon"><Icon name="plus" size={18} /></span>
            <span className="dock-label">Subir</span>
          </Link>
        </div>
      </nav>
    </div>
  )
}

function DashboardPage() {
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
  const recentDocuments = useQuery({
    queryKey: documentQueryKeys.list(1, 5),
    queryFn: () => listDocuments(1, 5),
    retry: 1,
  })

  const isRefreshing = backend.isFetching || database.isFetching || ai.isFetching
  const recentItems = recentDocuments.data?.items ?? []

  async function refreshHealth() {
    await Promise.all([backend.refetch(), database.refetch(), ai.refetch(), recentDocuments.refetch()])
  }

  return (
    <div className="dashboard-main">
      <div className="page-heading">
        <div>
          <p className="eyebrow">ESPACIO DE INVESTIGACIÓN</p>
          <h1>Espacio de trabajo</h1>
          <p className="page-subtitle">
            Evaluación local de señal de IA por párrafos (PDF, DOCX, TXT hasta {MAX_UPLOAD_MB} MB). Independiente de Turnitin.
          </p>
        </div>
        <div className="page-heading-actions">
          <Link className="button button-primary" to="/documents">
            <Icon name="upload" size={15} />
            <span>Subir documento</span>
          </Link>
          <Link className="button button-quiet" to="/analysis/compare">
            <Icon name="diff" size={15} />
            <span>Comparar versiones</span>
          </Link>
          <button
            className="button button-quiet refresh-button"
            type="button"
            onClick={() => void refreshHealth()}
            aria-label="Actualizar estado de los servicios"
            aria-busy={isRefreshing}
          >
            <Icon name="refresh" size={15} className={isRefreshing ? 'is-spinning' : undefined} />
            <span>Actualizar</span>
          </button>
        </div>
      </div>

      <section className="open-section" aria-labelledby="recent-docs-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">ACTIVIDAD RECIENTE</p>
            <h2 id="recent-docs-title">Últimos documentos</h2>
          </div>
          <Link className="button button-quiet" to="/documents">
            <span>Ver biblioteca completa</span>
            <Icon name="arrow-right" size={14} />
          </Link>
        </div>

        {recentItems.length === 0 ? (
          <div className="documents-empty-state">
            <span>Aún no hay documentos cargados en este entorno.</span>
            <Link className="button button-quiet" to="/documents">Subir primer documento</Link>
          </div>
        ) : (
          <div className="finder-table-wrap">
            <table className="finder-table" aria-label="Últimos documentos">
              <thead>
                <tr>
                  <th>Documento</th>
                  <th>Formato</th>
                  <th>Tamaño</th>
                  <th>Estado</th>
                  <th>Fecha</th>
                  <th className="finder-col-action">Acción</th>
                </tr>
              </thead>
              <tbody>
                {recentItems.map((doc) => (
                  <tr key={doc.id}>
                    <td className="finder-col-name">
                      <Link to={`/documents/${doc.id}`} title={doc.originalName}>
                        <Icon name="file" size={15} />
                        <span>{doc.originalName}</span>
                      </Link>
                    </td>
                    <td className="finder-col-mono">{doc.extension?.toUpperCase() || 'DOC'}</td>
                    <td className="finder-col-mono">{formatBytes(doc.sizeBytes)}</td>
                    <td>
                      <span className={statusClass(doc.status)}>{statusLabel(doc.status)}</span>
                    </td>
                    <td className="finder-col-date">
                      <time dateTime={doc.createdAt}>{formatDate(doc.createdAt)}</time>
                    </td>
                    <td className="finder-col-action">
                      <Link className="finder-row-action" to={`/documents/${doc.id}`}>
                        <span>Analizar</span>
                        <Icon name="arrow-right" size={14} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="health-section open-section" aria-labelledby="health-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">INFRAESTRUCTURA LOCAL</p>
            <h2 id="health-title">Servicios conectados</h2>
          </div>
          <span className="auto-refresh"><span className="live-pulse" /> Actualización cada 30 s</span>
        </div>
        <div className="service-grid">
          <ServiceStatusCard title="Backend API" description="API principal de la plataforma" endpoint={serviceEndpoints.backend} icon="server" service="backend" query={backend} />
          <ServiceStatusCard title="Base de datos" description="Conexión con PostgreSQL" endpoint={serviceEndpoints.database} icon="database" service="database" query={database} />
          <ServiceStatusCard title="Servicio de IA" description="Inferencia local de modelos" endpoint={serviceEndpoints.ai} icon="brain" service="ai" query={ai} />
        </div>
      </section>

      <footer className="page-footer">
        <span>Turniting · Análisis académico independiente</span>
        <span>F001 Documentos · F002 Reportes · F003 OCR · F004 Datasets · F005/F006.2 Research UI</span>
      </footer>
    </div>
  )
}

function NotFoundPage() {
  return (
    <main className="not-found-page">
      <span className="brand-mark" aria-hidden="true">T</span>
      <p className="eyebrow">PÁGINA NO DISPONIBLE</p>
      <h1>No encontramos esta página.</h1>
      <p>Vuelve al inicio para continuar en tu espacio de trabajo.</p>
      <Link className="button button-primary not-found-link" to="/">Ir al inicio <Icon name="arrow-right" size={17} /></Link>
    </main>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<WorkspaceLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="documents" element={<DocumentListPage />} />
        <Route path="documents/:id" element={<DocumentDetailPage />} />
        <Route path="turnitin-reports" element={<TurnitinReportsPage />} />
        <Route path="turnitin-reports/:id" element={<TurnitinReportDetailPage />} />
        <Route path="datasets" element={<DatasetsPage />} />
        <Route path="datasets/:id" element={<DatasetDetailPage />} />
        <Route path="models" element={<ModelsPage />} />
        <Route path="analysis/compare" element={<ComparePage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}

