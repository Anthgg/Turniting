import { useQuery } from '@tanstack/react-query'
import { Link, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import './App.css'
import { getHealth } from './api/health'
import type { HealthService } from './api/health'
import { Icon } from './components/Icon'
import { ServiceStatusCard } from './components/ServiceStatusCard'
import { ComparePage } from './features/analysis/ComparePage'
import { ModelsPage } from './features/analysis/ModelsPage'
import { DocumentDetailPage } from './features/documents/DocumentDetailPage'
import { DocumentListPage } from './features/documents/DocumentListPage'
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

function WorkspaceLayout() {
  const location = useLocation()
  const section = location.pathname === '/'
    ? 'Inicio'
    : location.pathname === '/documents'
      ? 'Documentos'
      : location.pathname.startsWith('/turnitin-reports')
        ? 'Reportes Turnitin'
      : location.pathname.startsWith('/datasets')
        ? 'Datasets'
      : location.pathname.startsWith('/models')
        ? 'Modelos'
      : location.pathname.startsWith('/analysis')
        ? 'Comparar versiones'
      : 'Detalle del documento'

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Saltar al contenido principal</a>
      <aside className="sidebar">
        <div className="sidebar-top">
          <Link className="brand" to="/" aria-label="Turniting, inicio">
            <span className="brand-mark" aria-hidden="true">T</span>
            <span className="brand-copy">
              <span className="brand-name">Turniting</span>
              <span className="brand-workspace">Área académica</span>
            </span>
          </Link>
        </div>

        <nav className="sidebar-nav" aria-label="Navegación principal">
          <NavLink to="/" end className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}>
            <Icon name="grid" size={17} />
            <span>Inicio</span>
          </NavLink>
          <NavLink to="/documents" className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}>
            <Icon name="file" size={17} />
            <span>Documentos</span>
          </NavLink>
          <NavLink to="/turnitin-reports" className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}>
            <Icon name="file" size={17} />
            <span>Reportes Turnitin</span>
          </NavLink>
          <NavLink to="/datasets" className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}>
            <Icon name="database" size={17} />
            <span>Datasets</span>
          </NavLink>
          <NavLink to="/models" className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}>
            <Icon name="brain" size={17} />
            <span>Modelos</span>
          </NavLink>
          <NavLink to="/analysis/compare" className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}>
            <Icon name="spark" size={17} />
            <span>Comparar versiones</span>
          </NavLink>
          <span className="nav-item is-disabled" aria-disabled="true" aria-label="Historial, próxima fase">
            <Icon name="clock" size={17} />
            <span>Historial</span>
          </span>
        </nav>

        <div className="sidebar-bottom">
          <div className="phase-summary">
            <span className="phase-label">Fase actual</span>
            <strong className="phase-value">F006.2 · Research UI</strong>
          </div>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs" aria-label="Ubicación actual">
            <Link to="/">Espacio de trabajo</Link>
            <Icon name="chevron-right" size={13} />
            <span className="breadcrumb-current" aria-current="page">{section}</span>
          </div>
          <div className="topbar-meta">
            <span className="environment-dot" aria-hidden="true" />
            <span>Entorno local</span>
          </div>
        </header>
        <main id="main-content" className="main-content"><Outlet /></main>
      </div>
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

  const isRefreshing = backend.isFetching || database.isFetching || ai.isFetching

  async function refreshHealth() {
    await Promise.all([backend.refetch(), database.refetch(), ai.refetch()])
  }

  return (
    <div className="dashboard-main">
      <div className="page-heading">
        <div>
          <p className="eyebrow">ESPACIO DE INVESTIGACIÓN</p>
          <h1>Turniting</h1>
          <p className="page-subtitle">Lectura, extracción y análisis local de señal de IA en documentos académicos.</p>
        </div>
        <div className="page-heading-actions">
          <Link className="button button-primary" to="/documents">
            <Icon name="upload" size={15} />
            <span>Subir documento</span>
          </Link>
          <button
            className="button button-quiet refresh-button"
            type="button"
            onClick={() => void refreshHealth()}
            aria-label="Actualizar estado de los servicios"
            aria-busy={isRefreshing}
          >
            <Icon name="refresh" size={15} className={isRefreshing ? 'is-spinning' : undefined} />
            <span>Actualizar estado</span>
          </button>
        </div>
      </div>

      <section className="open-section" aria-labelledby="welcome-title">
        <div className="open-section-row">
          <div>
            <h2 id="welcome-title" className="open-section-title">Ingesta y evaluación por párrafos</h2>
            <p className="open-section-copy">
              Sube archivos PDF, DOCX o TXT (hasta {MAX_UPLOAD_MB} MB) para extraer su texto e inspeccionar la señal probabilística de modelos locales.
              Los resultados son experimentales e independientes de Turnitin.
            </p>
          </div>
          <div className="open-section-links">
            <Link className="button button-quiet" to="/documents">Ir a documentos</Link>
            <Link className="button button-quiet" to="/analysis/compare">Comparar versiones</Link>
          </div>
        </div>
      </section>

      <section className="health-section open-section" aria-labelledby="health-title">
        <div className="section-heading">
          <div>
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
