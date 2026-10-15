import { useQuery } from '@tanstack/react-query'
import { Link, NavLink, Route, Routes } from 'react-router-dom'
import './App.css'
import { getHealth } from './api/health'
import type { HealthService } from './api/health'
import { Icon } from './components/Icon'
import { ServiceStatusCard } from './components/ServiceStatusCard'

const serviceEndpoints: Record<HealthService, string> = {
  backend: '/api/health',
  database: '/api/health/db',
  ai: '/api/health/ai',
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
    <div className="app-shell">
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
          <span className="nav-item is-disabled" aria-disabled="true" aria-label="Documentos, próxima fase">
            <Icon name="file" size={19} />
            <span>Documentos</span>
            <span className="nav-soon">Próxima fase</span>
          </span>
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
              <strong>F000 · Foundation</strong>
            </span>
          </div>
          <p className="sidebar-footnote">Un espacio para análisis académico responsable.</p>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs" aria-label="Ubicación actual">
            <span>Espacio de trabajo</span>
            <Icon name="chevron-right" size={14} />
            <span className="breadcrumb-current" aria-current="page">Inicio</span>
          </div>
          <div className="topbar-meta">
            <span className="environment-dot" aria-hidden="true" />
            <span>Entorno inicial</span>
          </div>
        </header>

        <main id="main-content" className="dashboard-main">
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
              <span className="welcome-kicker"><span className="welcome-kicker-dot" /> BASE LISTA PARA CRECER</span>
              <h2 id="welcome-title">Una mirada más clara al trabajo académico.</h2>
              <p>Prepara tu espacio para revisar documentos y comprender mejor sus señales de escritura.</p>
              <div className="welcome-actions">
                <button
                  className="button button-primary"
                  type="button"
                  disabled
                  aria-describedby="upload-phase-note"
                >
                  <Icon name="upload" size={17} />
                  <span>Subir documento</span>
                  <span className="button-phase">Próxima fase</span>
                </button>
                <span id="upload-phase-note" className="button-note">La carga se habilitará en la fase de ingesta.</span>
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
              <ServiceStatusCard
                title="Backend API"
                description="API principal de la plataforma"
                endpoint={serviceEndpoints.backend}
                icon="server"
                service="backend"
                query={backend}
              />
              <ServiceStatusCard
                title="Base de datos"
                description="Conexión con PostgreSQL"
                endpoint={serviceEndpoints.database}
                icon="database"
                service="database"
                query={database}
              />
              <ServiceStatusCard
                title="Servicio de IA"
                description="Servicio de análisis especializado"
                endpoint={serviceEndpoints.ai}
                icon="brain"
                service="ai"
                query={ai}
              />
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
                <span className="next-step-icon"><Icon name="file-plus" size={18} /></span>
                <span className="next-step-label">LO QUE SIGUE</span>
              </div>
              <h2>Ingesta de documentos</h2>
              <p>La carga segura de archivos será el próximo paso para habilitar tus análisis.</p>
              <span className="next-step-status"><span className="next-step-dot" /> Próxima fase · F001</span>
            </article>
          </section>

          <footer className="page-footer">
            <span>Turniting · Análisis académico responsable</span>
            <span>Fundación del producto · F000</span>
          </footer>
        </main>
      </div>
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
      <Route path="/" element={<DashboardPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}
