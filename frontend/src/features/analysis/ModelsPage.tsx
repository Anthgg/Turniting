import { useQuery } from '@tanstack/react-query'
import { analysisQueryKeys, listAnalyzerModels } from '../../api/analysis'
import { ApiErrorNotice } from '../documents/ApiErrorNotice'
import { availabilityLabel, isAnalyzerUsable } from './analysis-utils'
import './ModelsPage.css'

type ModelListData = Awaited<ReturnType<typeof listAnalyzerModels>>
type ModelItem = ModelListData['items'][number]

const FRIENDLY_MODEL_NAMES: Record<string, string> = {
  CANDIDATE_MODEL_V2: 'Modelo V2 de referencia',
  CANDIDATE_MODEL_V3: 'Modelo V3',
  ENSEMBLE_V2_V3: 'Combinación de modelos V2 y V3',
  EXPERIMENTAL_F006_MODEL: 'F006 · experimental',
  EXPERIMENTAL_F006_1_MODEL: 'F006.1 · experimental',
  EXPERIMENTAL_F006_1_1_MODEL: 'F006.1.1 · experimental',
  V2_ONLY: 'Modelo V2',
  V3_ONLY: 'Modelo V3',
  ENSEMBLE: 'Combinación de modelos V2 y V3',
  F006_1_ONLY: 'F006.1 · experimental',
  F006_1_1_ONLY: 'F006.1.1 · experimental',
}

const ANALYZER_MODE_TO_MODEL: Record<string, string> = {
  V2_ONLY: 'CANDIDATE_MODEL_V2',
  V3_ONLY: 'CANDIDATE_MODEL_V3',
  ENSEMBLE: 'ENSEMBLE_V2_V3',
  F006_1_ONLY: 'EXPERIMENTAL_F006_1_MODEL',
  F006_1_1_ONLY: 'EXPERIMENTAL_F006_1_1_MODEL',
}

function friendlyModelName(identifier: string | null | undefined) {
  if (!identifier) return 'No definido'
  const knownName = FRIENDLY_MODEL_NAMES[identifier]
  if (knownName) return knownName
  return identifier
    .replace(/[_-]+/gu, ' ')
    .toLocaleLowerCase('es-PE')
    .replace(/(^|\s)\p{L}/gu, (letter) => letter.toLocaleUpperCase('es-PE'))
}

function modelStatusLabel(status: string | null | undefined) {
  if (!status) return 'Estado no informado'
  if (status === 'EXPERIMENTAL') return 'Experimental'
  if (status === 'CANDIDATE') return 'Candidato'
  if (status === 'ACTIVE') return 'Activo según el registro'
  return status
    .replace(/[_-]+/gu, ' ')
    .toLocaleLowerCase('es-PE')
    .replace(/(^|\s)\p{L}/gu, (letter) => letter.toLocaleUpperCase('es-PE'))
}

function displayWarning(warning: string) {
  if (warning === 'SPANISH_FPR_REGRESSION') return 'La tasa de falsos positivos en personas en español es elevada.'
  if (warning === 'SPANISH_VALIDATION_SHIFT') return 'El resultado en español cambió entre validación y holdout.'
  return warning
}

function modelMatchesPreference(model: ModelItem, preferred: string | null | undefined) {
  if (!preferred) return false
  const canonical = ANALYZER_MODE_TO_MODEL[preferred] ?? preferred
  return model.name === canonical || model.modelId === preferred || model.id === preferred
}

function modelAvailabilityText(model: ModelItem) {
  if (model.researchMetadata && !model.researchMetadata.artifactAvailableLocally) {
    return 'No disponible localmente'
  }
  return availabilityLabel(model.availability)
}

function technicalValue(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return '—'
  return JSON.stringify(value) ?? '—'
}

function JsonDetails({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null) return null
  return (
    <section className="models-technical-section">
      <h4>{label}</h4>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </section>
  )
}

function ModelTechnicalDetails({ model }: { model: ModelItem }) {
  const research = model.researchMetadata

  return (
    <details className="models-technical-details">
      <summary>Detalles técnicos</summary>
      <div className="models-technical-content">
        <section className="models-technical-section">
          <h4>Registro e identificación</h4>
          <dl className="models-tech-list">
            <div><dt>Nombre interno</dt><dd>{model.name}</dd></div>
            <div><dt>ID de registro</dt><dd>{model.id ?? '—'}</dd></div>
            <div><dt>Estado registrado</dt><dd>{model.status ?? '—'}</dd></div>
            <div><dt>Arquitectura</dt><dd>{model.architecture ?? '—'}</dd></div>
            <div><dt>Variante</dt><dd>{model.variant ?? '—'}</dd></div>
            <div><dt>Dataset de referencia</dt><dd>{model.dataset ?? '—'}</dd></div>
            <div><dt>Registro en base de datos</dt><dd>{model.registeredInDatabase ? 'Sí' : 'No'}</dd></div>
            <div><dt>Registro en catálogo</dt><dd>{model.registeredInRegistry === undefined ? '—' : model.registeredInRegistry ? 'Sí' : 'No'}</dd></div>
            <div><dt>Modelo activo según el servicio</dt><dd>{model.active ? 'Sí' : 'No'}</dd></div>
            <div><dt>Marcado como candidato</dt><dd>{model.candidate === undefined ? '—' : model.candidate ? 'Sí' : 'No'}</dd></div>
            <div><dt>Disponible para servir</dt><dd>{model.servable ? 'Sí' : 'No'}</dd></div>
          </dl>
        </section>

        <section className="models-technical-section">
          <h4>Disponibilidad de artefactos</h4>
          <dl className="models-tech-list">
            <div><dt>Estado de disponibilidad</dt><dd>{model.availability}</dd></div>
            <div><dt>Disponible</dt><dd>{model.available === undefined ? '—' : model.available ? 'Sí' : 'No'}</dd></div>
            <div><dt>Pesos locales</dt><dd>{model.artifactPresent ? 'Presentes' : 'No disponibles'}</dd></div>
            <div><dt>Validación del artefacto</dt><dd>{model.artifactValid === undefined ? '—' : model.artifactValid ? 'Válido' : 'Pendiente o fallida'}</dd></div>
            <div><dt>Se esperaba SHA-256</dt><dd>{model.artifactChecksumExpected === undefined ? '—' : model.artifactChecksumExpected ? 'Sí' : 'No'}</dd></div>
            <div><dt>SHA-256 validado</dt><dd>{model.artifactChecksumValidated === undefined ? '—' : model.artifactChecksumValidated ? 'Sí' : 'No'}</dd></div>
          </dl>
          {model.missing && model.missing.length > 0 && <ul className="models-technical-list">{model.missing.map((item) => <li key={item}>{item}</li>)}</ul>}
        </section>

        <section className="models-technical-section">
          <h4>Preprocesamiento, rutas y umbrales</h4>
          <dl className="models-tech-list">
            <div><dt>Preprocesamiento</dt><dd>{model.preprocessing.join(' + ') || '—'}</dd></div>
            <div><dt>Perfiles de umbral</dt><dd>{model.thresholdProfiles.join(', ') || '—'}</dd></div>
            <div><dt>Origen del umbral</dt><dd>{model.thresholdSource ?? '—'}</dd></div>
            <div><dt>Proveedor del artefacto</dt><dd>{technicalValue(model.artifactProvider)}</dd></div>
            <div><dt>Modelo padre</dt><dd>{model.parentModel ?? research?.parentModel ?? '—'}</dd></div>
            <div><dt>Commit de origen</dt><dd>{model.sourceCommit ?? research?.sourceCommit ?? '—'}</dd></div>
            <div><dt>Enrutamiento por idioma</dt><dd>{model.languageRouting ?? research?.languageSelection ?? '—'}</dd></div>
          </dl>
          <JsonDetails label="Configuración de umbrales" value={model.thresholds} />
          <JsonDetails label="Fuentes de calibración" value={model.calibrationSources} />
        </section>

        <JsonDetails label="Métricas del modelo" value={model.metrics} />
        <JsonDetails label="Métricas registradas en la base de datos" value={model.registryMetrics} />
        <JsonDetails label="Gates y evidencias de promoción" value={{
          activeGateResults: model.activeGateResults,
          officialGateResults: model.officialGateResults,
          promotionEvidence: model.promotionEvidence,
          promotionEligible: model.promotionEligible,
          promotionReviewRequired: model.promotionReviewRequired,
        }} />
        <JsonDetails label="Metadatos de investigación, calibración y evaluación" value={research} />
        {model.strengths && model.strengths.length > 0 && <section className="models-technical-section">
          <h4>Fortalezas registradas</h4>
          <ul className="models-technical-list">{model.strengths.map((strength) => <li key={strength}>{strength}</li>)}</ul>
        </section>}
        {model.warnings.length > 0 && <section className="models-technical-section">
          <h4>Avisos registrados</h4>
          <ul className="models-technical-list">{[...new Set(model.warnings.map(displayWarning))].map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </section>}
      </div>
    </details>
  )
}

function ModelCard({ model, resolvedPreference }: { model: ModelItem; resolvedPreference: string | null | undefined }) {
  const preferred = modelMatchesPreference(model, resolvedPreference)
  const availableLocally = isAnalyzerUsable(model.availability)
    && !(model.researchMetadata && !model.researchMetadata.artifactAvailableLocally)
  const statusClass = availableLocally ? 'is-available' : 'is-unavailable'

  return (
    <article className="models-card">
      <header className="models-card-header">
        <div>
          <h2>{friendlyModelName(model.name)}</h2>
          <p>{modelStatusLabel(model.status)}</p>
        </div>
        <span className={`models-availability ${statusClass}`}>{modelAvailabilityText(model)}</span>
      </header>

      <div className="models-card-summary">
        <div>
          <span>Disponibilidad</span>
          <strong>{modelAvailabilityText(model)}</strong>
        </div>
        <div>
          <span>Uso local</span>
          <strong>{preferred ? 'Preferencia resuelta' : 'No es la preferencia local actual'}</strong>
        </div>
      </div>

      <div className="models-card-badges" aria-label="Estado de uso del modelo">
        {preferred && <span className="models-badge is-preferred">Preferido para análisis</span>}
        {model.active && <span className="models-badge">Activo según el servicio</span>}
        {model.candidate && <span className="models-badge">Candidato</span>}
        {model.servable && <span className="models-badge">Listo para servir</span>}
        {!preferred && !model.active && !model.candidate && !model.servable && <span className="models-badge is-muted">Sin uso habilitado reportado</span>}
      </div>

      {model.researchMetadata && !model.researchMetadata.artifactAvailableLocally && (
        <p className="models-card-note">Este artefacto de investigación no está disponible localmente.</p>
      )}
      {model.warnings.length > 0 && <ul className="models-card-warnings" aria-label={`Avisos de ${friendlyModelName(model.name)}`}>
        {[...new Set(model.warnings.map(displayWarning))].map((warning) => <li key={warning}>{warning}</li>)}
      </ul>}

      <ModelTechnicalDetails model={model} />
    </article>
  )
}

function GlobalTechnicalDetails({ modelList }: { modelList: ModelListData }) {
  const settings = Object.fromEntries(Object.entries(modelList).filter(([key]) => key !== 'items'))
  return (
    <details className="models-global-details">
      <summary>Detalles técnicos del registro y la política</summary>
      <pre>{JSON.stringify(settings, null, 2)}</pre>
    </details>
  )
}

export function ModelsOverview({ modelList }: { modelList: ModelListData }) {
  const preferred = modelList.localPreferredAnalyzer
  const resolved = modelList.resolvedLocalPreferredAnalyzer
  const fallback = modelList.localPreferredFallback
  const activeModel = modelList.activeModel
  const preferenceAvailabilityClass = modelList.localPreferredAvailable === undefined
    ? 'is-unknown'
    : modelList.localPreferredAvailable ? 'is-available' : 'is-unavailable'

  return (
    <div className="dashboard-main models-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">ANALIZADOR LOCAL</p>
          <h1>Modelos disponibles</h1>
          <p className="page-subtitle">Consulta qué modelos están disponibles y cuál se resuelve para el análisis local.</p>
        </div>
      </div>

      {!modelList.aiServiceReachable && <p className="models-service-notice" role="status">
        El servicio de IA no responde; esta lista muestra los datos registrados y la disponibilidad no se pudo comprobar ahora.
      </p>}
      {modelList.localPreferredWarning && <p className="models-preference-warning" role="status">{modelList.localPreferredWarning}</p>}

      <section className="models-overview" aria-label="Resumen del servicio de modelos">
        <article className="models-overview-card models-preference-card">
          <span className="models-overview-label">Preferencia local resuelta</span>
          <strong>{resolved ? friendlyModelName(resolved) : 'Ningún modelo disponible'}</strong>
          <span className={`models-state-text ${preferenceAvailabilityClass}`}>
            {modelList.localPreferredAvailable === undefined ? 'Disponibilidad no informada' : modelList.localPreferredAvailable ? 'Disponible para análisis' : 'No disponible para análisis'}
          </span>
          <p>Preferencia configurada: {preferred ? friendlyModelName(preferred) : 'No informada'}.</p>
          {fallback && <p>Alternativa configurada: {friendlyModelName(fallback)}{modelList.localPreferredFallbackAvailable === undefined ? '' : modelList.localPreferredFallbackAvailable ? ' · disponible' : ' · no disponible'}.</p>}
        </article>

        <article className="models-overview-card">
          <span className="models-overview-label">Modelo activo en producción</span>
          <strong>{activeModel === 'NONE' ? 'Ninguno' : activeModel ? friendlyModelName(activeModel) : 'No informado'}</strong>
          <span className="models-state-text">El estado se muestra como lo reporta el registro.</span>
        </article>

        <article className="models-overview-card">
          <span className="models-overview-label">Servicio de IA</span>
          <strong className={modelList.aiServiceReachable ? 'is-available' : 'is-unavailable'}>
            {modelList.aiServiceReachable ? 'Conectado' : 'Sin conexión'}
          </strong>
          <span className="models-state-text">{modelList.items.length} modelos en el catálogo</span>
        </article>
      </section>

      {modelList.nonServingResearchModels && modelList.nonServingResearchModels.length > 0 && <section className="models-research-section" aria-labelledby="models-research-title">
        <div className="models-section-heading">
          <div>
            <p className="eyebrow">ESTADO DE USO</p>
            <h2 id="models-research-title">Modelos de investigación no habilitados</h2>
          </div>
          <span>{modelList.nonServingResearchModels.length} registrados</span>
        </div>
        <div className="models-research-list">
          {modelList.nonServingResearchModels.map((model) => <article className="models-research-card" key={model.name}>
            <div>
              <h3>{friendlyModelName(model.name)}</h3>
              <p>{model.note}</p>
            </div>
            <div className="models-card-badges" aria-label={`Uso de ${friendlyModelName(model.name)}`}>
              <span className="models-badge is-muted">No activo</span>
              <span className="models-badge is-muted">No candidato</span>
              <span className="models-badge is-muted">No disponible para servir</span>
            </div>
          </article>)}
        </div>
      </section>}

      <section className="models-catalog-section" aria-labelledby="models-catalog-title">
        <div className="models-section-heading">
          <div>
            <p className="eyebrow">CATÁLOGO LOCAL</p>
            <h2 id="models-catalog-title">Disponibilidad por modelo</h2>
          </div>
        </div>
        {modelList.items.length > 0 ? (
          <div className="models-grid">
            {modelList.items.map((model) => <ModelCard key={model.name} model={model} resolvedPreference={resolved} />)}
          </div>
        ) : (
          <div className="models-empty-state">No hay modelos registrados para mostrar.</div>
        )}
      </section>

      <GlobalTechnicalDetails modelList={modelList} />
    </div>
  )
}

export function ModelsPage() {
  const models = useQuery({ queryKey: analysisQueryKeys.models(), queryFn: listAnalyzerModels, retry: 1 })

  return (
    <>
      {models.isError && <div className="dashboard-main models-page"><ApiErrorNotice error={models.error} title="No se pudo cargar el registro de modelos" /></div>}
      {models.isLoading && <div className="dashboard-main models-page"><p className="models-loading" role="status">Cargando disponibilidad de modelos…</p></div>}
      {models.data && <ModelsOverview modelList={models.data} />}
    </>
  )
}
