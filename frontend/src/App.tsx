import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import './App.css'
import { documentQueryKeys, getDocument, listDocuments } from './api/documents'
import { Icon } from './components/Icon'
import turnitingMark from './assets/brand/turniting-mark.png'
import { HomeRecentActivity } from './features/analysis/HomeRecentActivity'
import { formatDate, statusClass, statusLabel } from './features/documents/document-utils'
const ComparePage = lazy(() =>
  import('./features/analysis/ComparePage').then(({ ComparePage }) => ({ default: ComparePage })),
)
const ModelsPage = lazy(() =>
  import('./features/analysis/ModelsPage').then(({ ModelsPage }) => ({ default: ModelsPage })),
)
const QuickAnalysisPage = lazy(() =>
  import('./features/analysis/QuickAnalysisPage').then(({ QuickAnalysisPage }) => ({ default: QuickAnalysisPage })),
)
const AnalysisHistoryPage = lazy(() =>
  import('./features/analysis/AnalysisHistoryPage').then(({ AnalysisHistoryPage }) => ({ default: AnalysisHistoryPage })),
)
const DocumentDetailPage = lazy(() =>
  import('./features/documents/DocumentDetailPage').then(({ DocumentDetailPage }) => ({ default: DocumentDetailPage })),
)
const DocumentListPage = lazy(() =>
  import('./features/documents/DocumentListPage').then(({ DocumentListPage }) => ({ default: DocumentListPage })),
)
const DatasetDetailPage = lazy(() =>
  import('./features/datasets/DatasetDetailPage').then(({ DatasetDetailPage }) => ({ default: DatasetDetailPage })),
)
const DatasetsPage = lazy(() =>
  import('./features/datasets/DatasetsPage').then(({ DatasetsPage }) => ({ default: DatasetsPage })),
)
const TurnitinReportDetailPage = lazy(() =>
  import('./features/turnitin/TurnitinReportDetailPage').then(({ TurnitinReportDetailPage }) => ({ default: TurnitinReportDetailPage })),
)
const TurnitinReportsPage = lazy(() =>
  import('./features/turnitin/TurnitinReportsPage').then(({ TurnitinReportsPage }) => ({ default: TurnitinReportsPage })),
)
const ReportsPage = lazy(() =>
  import('./features/reports/ReportsPage').then(({ ReportsPage }) => ({ default: ReportsPage })),
)
const SettingsPage = lazy(() =>
  import('./features/settings/SettingsPage').then(({ SettingsPage }) => ({ default: SettingsPage })),
)

function RouteLoadingFallback() {
  return <div className="route-loading" role="status" aria-live="polite">Cargando vista…</div>
}

export function WorkspaceLayout() {
  const location = useLocation()
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false)
  const mobileMoreTriggerRef = useRef<HTMLButtonElement>(null)
  const mobileMorePanelRef = useRef<HTMLDivElement>(null)
  const docMatch = /^\/documents\/([^/]+)$/.exec(location.pathname)
  const activeDocId = docMatch ? decodeURIComponent(docMatch[1]) : null

  const activeDoc = useQuery({
    queryKey: activeDocId ? documentQueryKeys.detail(activeDocId) : ['documents', 'detail', 'none'],
    queryFn: () => getDocument(activeDocId!),
    enabled: Boolean(activeDocId),
    staleTime: 15_000,
    retry: 1,
  })

  const isReviewRoute = Boolean(activeDocId)
  const isQuickAnalysisRoute = location.pathname === '/analysis/quick'
  const analysisTargetHref = activeDocId ? `/documents/${activeDocId}` : '/documents'

  const isSettingsRoute = location.pathname.startsWith('/settings')
  const isMobileMoreActive = ['/analysis/compare', '/reports', '/turnitin-reports', '/history', '/models', '/datasets', '/settings'].some(
    (path) => location.pathname === path || location.pathname.startsWith(`${path}/`),
  )
  const pageTitle = location.pathname === '/'
    ? 'Inicio'
    : location.pathname === '/documents'
      ? 'Analizar documento'
      : isQuickAnalysisRoute
        ? 'Análisis rápido'
        : location.pathname === '/history'
          ? 'Historial de análisis'
        : isReviewRoute
          ? activeDoc.data?.originalName ?? 'Revisión'
          : location.pathname === '/analysis/compare'
            ? 'Comparar versiones'
            : location.pathname.startsWith('/reports')
              ? 'Reportes'
              : location.pathname.startsWith('/turnitin-reports')
                ? 'Reportes de Turnitin'
                : location.pathname.startsWith('/datasets')
                  ? 'Datasets'
                  : location.pathname.startsWith('/models') || location.pathname.startsWith('/settings/models')
                    ? 'Modelos'
                    : isSettingsRoute
                      ? 'Estado técnico'
                      : 'Turniting'

  useEffect(() => {
    if (!mobileMoreOpen) return
    const frame = window.requestAnimationFrame(() => {
      mobileMorePanelRef.current?.querySelector<HTMLElement>('.dock-sheet-close')?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [mobileMoreOpen])

  function closeMobileMore(returnFocus = false) {
    setMobileMoreOpen(false)
    if (returnFocus) {
      window.requestAnimationFrame(() => mobileMoreTriggerRef.current?.focus())
    }
  }

  function handleMobileMoreKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMobileMore(true)
      return
    }

    const panel = mobileMorePanelRef.current
    if (!panel) return
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]'))
    if (focusable.length === 0) return
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement)

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      focusable[(currentIndex + step + focusable.length) % focusable.length]?.focus()
    } else if (event.key === 'Tab') {
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || currentIndex < 0)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || currentIndex < 0)) {
        event.preventDefault()
        first.focus()
      }
    }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Saltar al contenido principal</a>

      <div className="app-frame">
        <header className="topbar">
          <Link className="topbar-brand" to="/" aria-label="Turniting, ir al inicio">
            <img src={turnitingMark} alt="" />
            <span>Turniting</span>
          </Link>
          <nav className="breadcrumbs" aria-label="Ubicación actual">
            {location.pathname !== '/' && <><Link to="/">Inicio</Link><Icon name="chevron-right" size={13} /></>}
            <span className="breadcrumb-current" aria-current="page" title={pageTitle}>{pageTitle}</span>
          </nav>
        </header>

        <div className="main-shell">
          <main id="main-content" className="main-content" tabIndex={-1}>
            <Suspense fallback={<RouteLoadingFallback />}>
              <Outlet />
            </Suspense>
          </main>
        </div>
      </div>

      <nav className="bottom-dock" aria-label="Navegación principal">
        <div className="bottom-dock-inner">
          <NavLink to="/" end className={({ isActive }) => `dock-item dock-core-item${isActive ? ' is-active' : ''}`} aria-label="Inicio" data-tooltip="Inicio">
            <span className="dock-icon"><Icon name="grid" size={18} /></span>
            <span className="dock-label">Inicio</span>
            <span className="dock-active-dot" aria-hidden="true" />
          </NavLink>

          <NavLink to="/documents" end className={({ isActive }) => `dock-item dock-core-item${isActive ? ' is-active' : ''}`} aria-label="Documentos" data-tooltip="Documentos">
            <span className="dock-icon"><Icon name="file" size={18} /></span>
            <span className="dock-label">Documentos</span>
            <span className="dock-active-dot" aria-hidden="true" />
          </NavLink>

          <Link to={analysisTargetHref} className={`dock-item dock-core-item${isReviewRoute ? ' is-active' : ''}`} aria-label="Revisión IA" aria-current={isReviewRoute ? 'page' : undefined} data-tooltip="Revisión IA">
            <span className="dock-icon"><Icon name="file-check" size={18} /></span>
            <span className="dock-label">Revisión</span>
            <span className="dock-active-dot" aria-hidden="true" />
          </Link>

          <NavLink to="/analysis/quick" end className={({ isActive }) => `dock-item dock-core-item${isActive ? ' is-active' : ''}`} aria-label="Análisis rápido" data-tooltip="Análisis rápido">
            <span className="dock-icon"><Icon name="spark" size={18} /></span>
            <span className="dock-label">Rápido</span>
            <span className="dock-active-dot" aria-hidden="true" />
          </NavLink>

          <NavLink to="/analysis/compare" className={({ isActive }) => `dock-item dock-secondary-item${isActive ? ' is-active' : ''}`} aria-label="Comparar versiones" data-tooltip="Comparar versiones">
            <span className="dock-icon"><Icon name="diff" size={18} /></span>
            <span className="dock-label">Comparar</span>
            <span className="dock-active-dot" aria-hidden="true" />
          </NavLink>

          <NavLink to="/reports" className={({ isActive }) => `dock-item dock-secondary-item${isActive ? ' is-active' : ''}`} aria-label="Reportes Turniting" data-tooltip="Reportes Turniting">
            <span className="dock-icon"><Icon name="layers" size={18} /></span>
            <span className="dock-label">Reportes</span>
            <span className="dock-active-dot" aria-hidden="true" />
          </NavLink>

          <NavLink to="/turnitin-reports" className={({ isActive }) => `dock-item dock-secondary-item${isActive ? ' is-active' : ''}`} aria-label="Reportes de Turnitin" data-tooltip="Reportes de Turnitin">
            <span className="dock-icon"><Icon name="shield-check" size={18} /></span>
            <span className="dock-label">Turnitin</span>
            <span className="dock-active-dot" aria-hidden="true" />
          </NavLink>

          <NavLink to="/history" className={({ isActive }) => `dock-item dock-secondary-item${isActive ? ' is-active' : ''}`} aria-label="Historial de análisis" data-tooltip="Historial de análisis">
            <span className="dock-icon"><Icon name="clock" size={18} /></span>
            <span className="dock-label">Historial</span>
            <span className="dock-active-dot" aria-hidden="true" />
          </NavLink>

          <NavLink to="/models" className={({ isActive }) => `dock-item dock-secondary-item${isActive ? ' is-active' : ''}`} aria-label="Modelos" data-tooltip="Modelos">
            <span className="dock-icon"><Icon name="brain" size={18} /></span>
            <span className="dock-label">Modelos</span>
            <span className="dock-active-dot" aria-hidden="true" />
          </NavLink>

          <NavLink to="/datasets" className={({ isActive }) => `dock-item dock-secondary-item${isActive ? ' is-active' : ''}`} aria-label="Datasets" data-tooltip="Datasets">
            <span className="dock-icon"><Icon name="database" size={18} /></span>
            <span className="dock-label">Datasets</span>
            <span className="dock-active-dot" aria-hidden="true" />
          </NavLink>

          <NavLink to="/settings" className={({ isActive }) => `dock-item dock-secondary-item${isActive ? ' is-active' : ''}`} aria-label="Estado técnico" data-tooltip="Estado técnico">
            <span className="dock-icon"><Icon name="server" size={18} /></span>
            <span className="dock-label">Estado</span>
            <span className="dock-active-dot" aria-hidden="true" />
          </NavLink>

          <span className="dock-divider" aria-hidden="true" />

          <Link to="/documents" className="dock-item dock-secondary-item dock-item-upload" aria-label="Subir nuevo documento" data-tooltip="Subir documento">
            <span className="dock-icon"><Icon name="plus" size={18} /></span>
            <span className="dock-label">Subir</span>
          </Link>

          <button
            ref={mobileMoreTriggerRef}
            className={`dock-item dock-mobile-more${isMobileMoreActive ? ' is-active' : ''}`}
            type="button"
            aria-label="Más herramientas"
            aria-expanded={mobileMoreOpen}
            aria-haspopup="dialog"
            aria-controls="mobile-more-sheet"
            onClick={() => setMobileMoreOpen(true)}
          >
            <span className="dock-icon"><Icon name="more" size={19} /></span>
            <span className="dock-label">Más</span>
            <span className="dock-active-dot" aria-hidden="true" />
          </button>
        </div>
      </nav>

      {mobileMoreOpen && (
        <>
          <button className="dock-sheet-backdrop" type="button" aria-label="Cerrar menú Más" onClick={() => closeMobileMore(true)} />
          <div
            id="mobile-more-sheet"
            className="dock-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dock-sheet-title"
            ref={mobileMorePanelRef}
            onKeyDown={handleMobileMoreKeyDown}
          >
            <div className="dock-sheet-handle" aria-hidden="true" />
            <div className="dock-sheet-heading">
              <div>
                <p className="eyebrow">HERRAMIENTAS</p>
                <h2 id="dock-sheet-title">Más opciones</h2>
              </div>
              <button className="dock-sheet-close" type="button" aria-label="Cerrar menú Más" onClick={() => closeMobileMore(true)}>
                <Icon name="close" size={18} />
              </button>
            </div>
            <div className="dock-sheet-grid">
              <NavLink to="/analysis/compare" onClick={() => closeMobileMore(true)}><Icon name="diff" size={18} /><span>Comparar</span></NavLink>
              <NavLink to="/reports" onClick={() => closeMobileMore(true)}><Icon name="layers" size={18} /><span>Reportes</span></NavLink>
              <NavLink to="/turnitin-reports" onClick={() => closeMobileMore(true)}><Icon name="shield-check" size={18} /><span>Turnitin</span></NavLink>
              <NavLink to="/history" onClick={() => closeMobileMore(true)}><Icon name="clock" size={18} /><span>Historial</span></NavLink>
              <NavLink to="/models" onClick={() => closeMobileMore(true)}><Icon name="brain" size={18} /><span>Modelos</span></NavLink>
              <NavLink to="/datasets" onClick={() => closeMobileMore(true)}><Icon name="database" size={18} /><span>Datasets</span></NavLink>
              <NavLink to="/settings" onClick={() => closeMobileMore(true)}><Icon name="server" size={18} /><span>Estado</span></NavLink>
              <NavLink to="/documents" onClick={() => closeMobileMore(true)}><Icon name="plus" size={18} /><span>Subir documento</span></NavLink>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function DashboardPage() {
  const recentDocuments = useQuery({
    queryKey: documentQueryKeys.list(1, 5),
    queryFn: () => listDocuments(1, 5),
    staleTime: 15_000,
    retry: 1,
  })

  const recentItems = recentDocuments.data?.items ?? []

  return (
    <div className="dashboard-main home-main">
      <div className="page-heading">
        <div>
          <p className="eyebrow">TU ESPACIO DE TRABAJO</p>
          <h1>Inicio</h1>
          <p className="page-subtitle">Elige qué quieres analizar y continúa donde te quedaste.</p>
        </div>
      </div>

      <section className="home-action-grid" aria-label="Acciones principales">
        <Link className="home-action-card is-primary" to="/documents">
          <span className="home-action-icon"><Icon name="file-plus" size={20} /></span>
          <span className="home-action-copy">
            <strong>Analizar documento</strong>
            <span>Sube un PDF, DOCX u otro formato compatible para revisar el documento completo.</span>
          </span>
          <Icon name="arrow-right" size={17} className="home-action-arrow" />
        </Link>
        <Link className="home-action-card" to="/analysis/quick">
          <span className="home-action-icon"><Icon name="spark" size={20} /></span>
          <span className="home-action-copy">
            <strong>Análisis rápido</strong>
            <span>Evalúa un fragmento de texto sin cargar un documento.</span>
          </span>
          <Icon name="arrow-right" size={17} className="home-action-arrow" />
        </Link>
      </section>

      <section className="open-section home-recent-section" aria-labelledby="recent-docs-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">ACTIVIDAD</p>
            <h2 id="recent-docs-title">Documentos recientes</h2>
          </div>
          <Link className="button button-quiet" to="/documents">
            <span>Ver documentos</span>
            <Icon name="arrow-right" size={14} />
          </Link>
        </div>

        {recentDocuments.isPending && (
          <div className="documents-empty-state" role="status" aria-live="polite">
            <span className="state-indicator is-animated" />
            <span>Cargando actividad reciente…</span>
          </div>
        )}

        {recentDocuments.isError && (
          <div className="documents-empty-state" role="alert">
            <strong>No se pudo cargar la actividad reciente.</strong>
            <button className="button button-quiet" type="button" onClick={() => void recentDocuments.refetch()} disabled={recentDocuments.isFetching}>
              Reintentar
            </button>
          </div>
        )}

        {recentDocuments.data && recentItems.length === 0 ? (
          <div className="documents-empty-state">
            <strong>Aún no hay documentos</strong>
            <span>Sube un archivo para empezar una revisión completa.</span>
            <Link className="button button-quiet" to="/documents">Analizar documento</Link>
          </div>
        ) : recentItems.length > 0 ? (
          <div className="home-recent-list" role="list" aria-label="Documentos recientes">
            {recentItems.map((doc) => (
              <article className="home-recent-item" role="listitem" key={doc.id}>
                <Link className="home-recent-document" to={`/documents/${doc.id}`} title={doc.originalName}>
                  <span className="home-recent-icon"><Icon name="file" size={17} /></span>
                  <span className="home-recent-copy">
                    <strong>{doc.originalName}</strong>
                    <small>{formatDate(doc.createdAt)}</small>
                  </span>
                </Link>
                <span className={statusClass(doc.status)}>{statusLabel(doc.status)}</span>
                <Link className="finder-row-action home-recent-action" to={`/documents/${doc.id}`}>
                  <span>{doc.status === 'EXTRACTED' ? 'Abrir análisis' : 'Ver estado'}</span>
                  <Icon name="arrow-right" size={14} />
                </Link>
              </article>
            ))}
          </div>
        ) : null}
      </section>

      <HomeRecentActivity />

      <section className="home-secondary-links" aria-label="Más herramientas">
        <Link to="/analysis/compare"><Icon name="diff" size={16} />Comparar versiones<Icon name="arrow-right" size={14} /></Link>
        <Link to="/history"><Icon name="clock" size={16} />Historial<Icon name="arrow-right" size={14} /></Link>
      </section>
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
        <Route path="reports" element={<ReportsPage />} />
        <Route path="history" element={<AnalysisHistoryPage />} />
        <Route path="turnitin-reports" element={<TurnitinReportsPage />} />
        <Route path="turnitin-reports/:id" element={<TurnitinReportDetailPage />} />
        <Route path="datasets" element={<DatasetsPage />} />
        <Route path="datasets/:id" element={<DatasetDetailPage />} />
        <Route path="models" element={<ModelsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="settings/system" element={<Navigate to="/settings" replace />} />
        <Route path="settings/models" element={<Navigate to="/models" replace />} />
        <Route path="analysis/quick" element={<QuickAnalysisPage />} />
        <Route path="analysis/compare" element={<ComparePage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}

