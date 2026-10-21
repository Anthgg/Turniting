import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import './App.css'
import { documentQueryKeys, getDocument, listDocuments } from './api/documents'
import { Icon } from './components/Icon'
import { ComparePage } from './features/analysis/ComparePage'
import { ModelsPage } from './features/analysis/ModelsPage'
import { QuickAnalysisPage } from './features/analysis/QuickAnalysisPage'
import { AnalysisHistoryPage } from './features/analysis/AnalysisHistoryPage'
import { HomeRecentActivity } from './features/analysis/HomeRecentActivity'
import { DocumentDetailPage } from './features/documents/DocumentDetailPage'
import { DocumentListPage } from './features/documents/DocumentListPage'
import { formatDate, statusClass, statusLabel } from './features/documents/document-utils'
import { DatasetDetailPage } from './features/datasets/DatasetDetailPage'
import { DatasetsPage } from './features/datasets/DatasetsPage'
import { TurnitinReportDetailPage } from './features/turnitin/TurnitinReportDetailPage'
import { TurnitinReportsPage } from './features/turnitin/TurnitinReportsPage'
import { ReportsPage } from './features/reports/ReportsPage'
import { SettingsPage } from './features/settings/SettingsPage'

export function WorkspaceLayout() {
  const location = useLocation()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)
  const [tabletSidebar, setTabletSidebar] = useState(false)
  const menuToggleRef = useRef<HTMLButtonElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
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

  const isReviewRoute = Boolean(activeDocId)
  const isQuickAnalysisRoute = location.pathname === '/analysis/quick'
  const isSettingsRoute = location.pathname.startsWith('/settings')
  const effectiveSidebarCollapsed = sidebarCollapsed || tabletSidebar
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
    const media = window.matchMedia('(min-width: 761px) and (max-width: 1024px)')
    const updateTablet = () => setTabletSidebar(media.matches)
    updateTablet()
    media.addEventListener('change', updateTablet)
    return () => media.removeEventListener('change', updateTablet)
  }, [])

  useEffect(() => {
    const closeDrawerOnHistoryNavigation = () => setMobileDrawerOpen(false)
    window.addEventListener('popstate', closeDrawerOnHistoryNavigation)
    return () => window.removeEventListener('popstate', closeDrawerOnHistoryNavigation)
  }, [])

  useEffect(() => {
    if (!mobileDrawerOpen) return

    const panel = sidebarRef.current
    const previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusable = () => Array.from(
      panel?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [],
    ).filter((element) => element.getClientRects().length > 0)
    panel?.querySelector<HTMLElement>('.mobile-drawer-close')?.focus()

    function handleDrawerKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMobileDrawerOpen(false)
        window.requestAnimationFrame(() => menuToggleRef.current?.focus())
        return
      }
      if (event.key !== 'Tab') return

      const items = focusable()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === first || !panel?.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !panel?.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', handleDrawerKeyDown)
    return () => {
      window.removeEventListener('keydown', handleDrawerKeyDown)
      document.body.style.overflow = previousBodyOverflow
    }
  }, [mobileDrawerOpen])

  function closeMobileDrawer(focusMain = false) {
    if (!mobileDrawerOpen) return
    setMobileDrawerOpen(false)
    window.requestAnimationFrame(() => {
      if (focusMain) document.getElementById('main-content')?.focus()
      else menuToggleRef.current?.focus()
    })
  }

  const sidebarLinkClass = ({ isActive }: { isActive: boolean }) =>
    `sidebar-link${isActive ? ' is-active' : ''}`

  return (
    <div className={`app-shell${effectiveSidebarCollapsed ? ' is-sidebar-collapsed' : ''}${mobileDrawerOpen ? ' is-mobile-drawer-open' : ''}`}>
      <a className="skip-link" href="#main-content">Saltar al contenido principal</a>

      {mobileDrawerOpen && (
        <button
          className="sidebar-backdrop"
          type="button"
          tabIndex={-1}
          aria-label="Cerrar navegación"
          onClick={() => closeMobileDrawer()}
        />
      )}

      <aside
        ref={sidebarRef}
        id="primary-navigation-panel"
        className={`app-sidebar${effectiveSidebarCollapsed ? ' is-collapsed' : ''}${mobileDrawerOpen ? ' is-mobile-open' : ''}`}
        aria-label="Navegación principal"
        role={mobileDrawerOpen ? 'dialog' : undefined}
        aria-modal={mobileDrawerOpen || undefined}
      >
        <div className="sidebar-brand-row">
          <Link className="brand" to="/" aria-label="Turniting, inicio" onClick={() => closeMobileDrawer(true)}>
            <span className="brand-mark" aria-hidden="true">T</span>
            <span className="brand-name">Turniting</span>
          </Link>
          <button
            className="sidebar-collapse-toggle"
            type="button"
            aria-label={effectiveSidebarCollapsed ? 'Expandir navegación' : 'Contraer navegación'}
            aria-controls="primary-navigation"
            aria-expanded={!effectiveSidebarCollapsed}
            title={effectiveSidebarCollapsed ? 'Expandir navegación' : 'Contraer navegación'}
            onClick={() => setSidebarCollapsed((value) => !value)}
          >
            <Icon name="chevron-right" size={16} />
          </button>
          <button
            className="mobile-drawer-close"
            type="button"
            aria-label="Cerrar navegación"
            onClick={() => closeMobileDrawer()}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <nav className="sidebar-navigation" id="primary-navigation" aria-label="Principal">
          <div className="sidebar-group">
            <span className="sidebar-group-label">Inicio</span>
            <NavLink to="/" end className={sidebarLinkClass} aria-label="Inicio" title="Inicio" onClick={() => closeMobileDrawer(true)}>
              <Icon name="grid" size={18} /><span className="sidebar-link-label">Inicio</span>
            </NavLink>
          </div>

          <div className="sidebar-group">
            <span className="sidebar-group-label">Analizar</span>
            <NavLink to="/documents" end className={sidebarLinkClass} aria-label="Analizar documento" title="Analizar documento" onClick={() => closeMobileDrawer(true)}>
              <Icon name="file-plus" size={18} /><span className="sidebar-link-label">Documento</span>
            </NavLink>
            <NavLink to="/analysis/quick" end className={sidebarLinkClass} aria-label="Análisis rápido" title="Análisis rápido" onClick={() => closeMobileDrawer(true)}>
              <Icon name="spark" size={18} /><span className="sidebar-link-label">Análisis rápido</span>
            </NavLink>
          </div>

          <div className="sidebar-group">
            <span className="sidebar-group-label">Resultados</span>
            <Link to={analysisTargetHref} className={`sidebar-link${isReviewRoute ? ' is-active' : ''}`} aria-label="Revisión" aria-current={isReviewRoute ? 'page' : undefined} title="Revisión" onClick={() => closeMobileDrawer(true)}>
              <Icon name="file" size={18} /><span className="sidebar-link-label">Revisión</span>
            </Link>
            <NavLink to="/reports" className={sidebarLinkClass} aria-label="Reportes" title="Reportes" onClick={() => closeMobileDrawer(true)}>
              <Icon name="layers" size={18} /><span className="sidebar-link-label">Reportes</span>
            </NavLink>
            <NavLink to="/history" className={sidebarLinkClass} aria-label="Historial de análisis" title="Historial de análisis" onClick={() => closeMobileDrawer(true)}>
              <Icon name="clock" size={18} /><span className="sidebar-link-label">Historial</span>
            </NavLink>
            <NavLink to="/turnitin-reports" className={sidebarLinkClass} aria-label="Reportes de Turnitin" title="Reportes de Turnitin" onClick={() => closeMobileDrawer(true)}>
              <Icon name="file" size={18} /><span className="sidebar-link-label">Reportes de Turnitin</span>
            </NavLink>
            <NavLink to="/analysis/compare" className={sidebarLinkClass} aria-label="Comparar versiones" title="Comparar versiones" onClick={() => closeMobileDrawer(true)}>
              <Icon name="diff" size={18} /><span className="sidebar-link-label">Comparar versiones</span>
            </NavLink>
          </div>

          <div className="sidebar-group">
            <span className="sidebar-group-label">Configuración</span>
            <NavLink to="/models" className={sidebarLinkClass} aria-label="Modelos" title="Modelos" onClick={() => closeMobileDrawer(true)}>
              <Icon name="brain" size={18} /><span className="sidebar-link-label">Modelos</span>
            </NavLink>
            <NavLink to="/datasets" className={sidebarLinkClass} aria-label="Datasets" title="Datasets" onClick={() => closeMobileDrawer(true)}>
              <Icon name="database" size={18} /><span className="sidebar-link-label">Datasets</span>
            </NavLink>
            <NavLink to="/settings" className={sidebarLinkClass} aria-label="Estado técnico" title="Estado técnico" onClick={() => closeMobileDrawer(true)}>
              <Icon name="server" size={18} /><span className="sidebar-link-label">Estado técnico</span>
            </NavLink>
          </div>
        </nav>

        <div className="sidebar-footer">
          <Link className="sidebar-local-status" to="/settings" aria-label="Estado local: ver estado técnico" title="Estado local" onClick={() => closeMobileDrawer(true)}>
            <span className="environment-dot" aria-hidden="true" />
            <span className="sidebar-link-label">Estado local</span>
          </Link>
        </div>
      </aside>

      <div className="app-frame" inert={mobileDrawerOpen}>
        <header className="topbar">
          <button
            ref={menuToggleRef}
            className="mobile-menu-toggle"
            type="button"
            aria-label={mobileDrawerOpen ? 'Cerrar navegación' : 'Abrir navegación'}
            aria-controls="primary-navigation-panel"
            aria-expanded={mobileDrawerOpen}
            onClick={() => setMobileDrawerOpen((value) => !value)}
          >
            <span className="mobile-menu-glyph" aria-hidden="true"><i /><i /><i /></span>
          </button>
          <nav className="breadcrumbs" aria-label="Ubicación actual">
            {location.pathname !== '/' && <><Link to="/">Inicio</Link><Icon name="chevron-right" size={13} /></>}
            <span className="breadcrumb-current" aria-current="page" title={pageTitle}>{pageTitle}</span>
          </nav>
        </header>

        <div className="main-shell">
          <main id="main-content" className="main-content" tabIndex={-1}><Outlet /></main>
        </div>
      </div>
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

