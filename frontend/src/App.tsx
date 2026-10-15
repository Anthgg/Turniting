import { useQuery } from '@tanstack/react-query'
import { Link, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import './App.css'
import { getHealth } from './api/health'
import type { HealthService } from './api/health'
import { Icon } from './components/Icon'
import { ServiceStatusCard } from './components/ServiceStatusCard'
import { DocumentDetailPage } from './features/documents/DocumentDetailPage'
import { DocumentListPage } from './features/documents/DocumentListPage'
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
      : 'Detalle del documento'

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Saltar al contenido principal</a>
      <aside className="sidebar">
        <div className="sidebar-top">
          <Link className="brand" to="/" aria-label="Turniting, inicio">
            <span className="brand-mark" aria-hidden="true">T</span>
            <span className="brand-name">Turniting</span>
          </Link>
        </div>

        <div className="workspace-switcher" aria-label="Espacio de trabajo actual">
          <span className="workspace-avatar" aria-hidden="true">A</span>
          <span className="workspace-copy">
            <span className="workspace-label">Espacio de trabajo</span>
            <span className="workspace-name">Área académica</span>
          </span>
          <Icon name="chevrons" size={16} className="workspace-chevron" />
        </div>

        <nav className="sidebar-nav" aria-label="Navegación principal">
          <p className="nav-caption">MENÚ</p>
          <NavLink to="/" end className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}>
            <Icon name="grid" size={19} />
            <span>Inicio</span>
          </NavLink>
          <NavLink to="/documents" className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}>
            <Icon name="file" size={19} />
            <span>Documentos</span>
          </NavLink>
          <span className="nav-item is-disabled" aria-disabled="true" aria-label="Historial, próxima fase">
            <Icon name="clock" size={19} />
            <span>Historial</span>
          </span>
        </nav>

        <div className="sidebar-bottom">
          <div className="phase-card">
            <span className="phase-icon"><Icon name="spark" size={17} /></span>
            <span className="phase-copy">
              <span>Fase actual</span>
              <strong>F001 · Ingesta</strong>
            </span>
          </div>
          <p className="sidebar-footnote">Un espacio para análisis académico responsable.</p>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs" aria-label="Ubicación actual">
            <Link to="/">Espacio de trabajo</Link>
            <Icon name="chevron-right" size={14} />
            <span className="breadcrumb-current" aria-current="page">{section}</span>
          </div>
          <div className="topbar-meta">
            <span className="environment-dot" aria-hidden="true" />
            <span>Entorno inicial</span>
          </div>
        </header>
        <main id="main-content"><Outlet /></main>
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
          <p className="eyebrow">TU ESPACIO DE TRABAJO</p>
          <h1>Turniting</h1>
          <p className="page-subtitle">Análisis académico asistido por inteligencia artificial</p>
        </div>
        <button
          className="button button-quiet refresh-button"
          type="button"
          onClick={() => void refreshHealth()}
          aria-label="Actualizar estado de los servicios"
          aria-busy={isRefreshing}
        >
          <Icon name="refresh" size={17} className={isRefreshing ? 'is-spinning' : undefined} />
          <span>Actualizar estado</span>
        </button>
      </div>

      <section className="welcome-panel" aria-labelledby="welcome-title">
        <div className="welcome-content">
          <span className="welcome-kicker"><span className="welcome-kicker-dot" /> INGESTA DE DOCUMENTOS</span>
          <h2 id="welcome-title">Una mirada más clara al trabajo académico.</h2>
          <p>Sube un documento para extraer su texto y consultar su estado de procesamiento.</p>
          <div className="welcome-actions">
            <Link className="button button-primary" to="/documents">
              <Icon name="upload" size={17} />
              <span>Subir documento</span>
            </Link>
            <span className="button-note">PDF, DOCX o TXT · hasta {MAX_UPLOAD_MB} MB</span>
          </div>
        </div>
        <div className="welcome-visual" aria-hidden="true">
          <div className="visual-orbit orbit-one" />
          <div className="visual-orbit orbit-two" />
          <div className="visual-spark spark-one" />
          <div className="visual-spark spark-two" />
          <div className="visual-document">
            <div className="visual-doc-top"><span /><span /></div>
            <div className="visual-doc-title" />
            <div className="visual-doc-line line-long" />
            <div className="visual-doc-line" />
            <div className="visual-highlight"><span /><span /></div>
            <div className="visual-doc-line line-short" />
            <div className="visual-doc-line line-long" />
          </div>
          <div className="visual-badge"><span className="visual-badge-icon"><Icon name="spark" size={13} /></span><span>Lectura con contexto</span></div>
          <div className="visual-score"><span className="score-ring"><Icon name="check" size={14} /></span><span><strong>Señales</strong><small>con transparencia</small></span></div>
        </div>
      </section>

      <section className="health-section" aria-labelledby="health-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">ESTADO DEL SISTEMA</p>
            <h2 id="health-title">Servicios conectados</h2>
          </div>
          <span className="auto-refresh"><span className="live-pulse" /> Actualización automática cada 30 s</span>
        </div>
        <div className="service-grid">
          <ServiceStatusCard title="Backend API" description="API principal de la plataforma" endpoint={serviceEndpoints.backend} icon="server" service="backend" query={backend} />
          <ServiceStatusCard title="Base de datos" description="Conexión con PostgreSQL" endpoint={serviceEndpoints.database} icon="database" service="database" query={database} />
          <ServiceStatusCard title="Servicio de IA" description="Servicio de análisis especializado" endpoint={serviceEndpoints.ai} icon="brain" service="ai" query={ai} />
        </div>
      </section>

      <section className="lower-grid" aria-label="Información del análisis">
        <article className="transparency-card">
          <span className="transparency-icon"><Icon name="shield-check" size={20} /></span>
          <div>
            <p className="eyebrow">TRANSPARENCIA</p>
            <h2>Un análisis independiente, siempre en contexto.</h2>
            <p>Turniting ofrece un análisis académico probabilístico e independiente. No es un resultado oficial de Turnitin ni reproduce su algoritmo propietario.</p>
          </div>
          <span className="transparency-decoration" aria-hidden="true"><Icon name="spark" size={46} /></span>
        </article>

        <article className="next-step-card">
          <div className="next-step-heading">
            <span className="next-step-icon"><Icon name="spark" size={18} /></span>
            <span className="next-step-label">LO QUE SIGUE</span>
          </div>
          <h2>Análisis con inteligencia artificial</h2>
          <p>Las señales de escritura y las estimaciones probabilísticas estarán disponibles en una fase posterior.</p>
          <span className="next-step-status"><span className="next-step-dot" /> Próximamente</span>
        </article>
      </section>

      <footer className="page-footer">
        <span>Turniting · Análisis académico responsable</span>
        <span>Ingesta de documentos · F001</span>
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
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}
