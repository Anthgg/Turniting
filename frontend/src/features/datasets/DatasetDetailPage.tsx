import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { CustomSelect } from '../../components/CustomSelect'
import { TurnitingFeedback } from '../../components/TurnitingFeedback'
import {
  datasetQueryKeys,
  getDataset,
  getDatasetArtifacts,
  getDatasetSamples,
  getDatasetSources,
  getDatasetStatistics,
} from '../../api/datasets'
import { ApiErrorNotice } from '../documents/ApiErrorNotice'
import { LicenseWarning } from './LicenseWarning'
import {
  datasetStatusLabel,
  formatBytes,
  formatCount,
  formatMetric,
  licenseStatusLabel,
  modelStatusLabel,
  selectedMetrics,
} from './dataset-utils'

const SAMPLE_FILTERS = {
  label: ['', 'HUMAN', 'MACHINE', 'MIXED', 'UNKNOWN'],
  labelSource: ['', 'PUBLIC_DATASET', 'TURNITIN_AI_FLAGGED', 'MANUAL', 'SYNTHETIC', 'DERIVED', 'UNKNOWN'],
  split: ['', 'TRAIN', 'VALIDATION', 'TEST', 'OOD', 'UNKNOWN'],
  eligibleForTraining: ['', 'true', 'false'],
} as const

export function DatasetDetailPage() {
  const { id = '' } = useParams()
  const [filters, setFilters] = useState<Record<string, string>>({})
  const dataset = useQuery({ queryKey: datasetQueryKeys.detail(id), queryFn: () => getDataset(id), retry: 1 })
  const sources = useQuery({ queryKey: datasetQueryKeys.part(id, 'sources'), queryFn: () => getDatasetSources(id), retry: 1 })
  const stats = useQuery({ queryKey: datasetQueryKeys.part(id, 'statistics'), queryFn: () => getDatasetStatistics(id), retry: 1 })
  const artifacts = useQuery({ queryKey: datasetQueryKeys.part(id, 'artifacts'), queryFn: () => getDatasetArtifacts(id), retry: 1 })
  const samples = useQuery({
    queryKey: datasetQueryKeys.part(id, 'samples', JSON.stringify(filters)),
    queryFn: () => getDatasetSamples(id, filters),
    retry: 1,
  })

  if (dataset.isError) return <div className="dashboard-main"><ApiErrorNotice error={dataset.error} title="No se pudo cargar el dataset" /></div>
  if (!dataset.data) return <div className="dashboard-main"><TurnitingFeedback state="reading" title="Leyendo el dataset" description="Cargando metadata, fuentes y estadísticas…" className="documents-empty-state" layout="inline" /></div>
  const d = dataset.data
  const leakage = stats.data?.statistics?.leakage

  return (
    <div className="dashboard-main datasets-main">
      <div className="page-heading">
        <div>
          <p className="eyebrow">DATASET · {datasetStatusLabel(d.status).toUpperCase()}</p>
          <h1>{d.displayName}</h1>
          <p className="page-subtitle">Manifiesto: {d.manifestPath ?? '—'} · Estadísticas: {d.statisticsPath ?? '—'} · Commit: {d.createdFromGitCommit?.slice(0, 10) ?? '—'}</p>
        </div>
        <Link className="button button-quiet" to="/datasets">Volver a datasets</Link>
      </div>

      <LicenseWarning warnings={d.licenseWarnings} />

      <section className="dataset-stat-grid" aria-label="Estadísticas principales">
        {[
          ['Filas', d.totalRows], ['Humano', d.humanRows], ['Máquina', d.machineRows], ['Mixto', d.mixedRows],
          ['Español', d.spanishRows], ['Académico', d.academicRows], ['Idiomas', d.languageCount], ['Dominios', d.domainCount],
          ['Familias de generadores', d.generatorCount], ['Duplicados exactos', d.exactDuplicatesRemoved],
          ['Near-duplicates', d.nearDuplicatesRemoved], ['Conflictos de etiqueta', d.labelConflicts],
        ].map(([label, value]) => (
          <div className="dataset-stat" key={String(label)}><span>{label}</span><strong>{formatCount(value as number | null)}</strong></div>
        ))}
        <div className={`dataset-stat ${d.leakageStatus === 'PASS' ? 'is-ok' : 'is-bad'}`}><span>Leakage</span><strong>{d.leakageStatus ?? '—'}</strong></div>
      </section>

      <section className="documents-section" aria-labelledby="models-title">
        <div className="documents-section-heading">
          <div><p className="eyebrow">MODELOS</p><h2 id="models-title">Modelos asociados</h2></div>
          <span className="documents-section-meta">Solo metadata · ningún modelo está activo en producción</span>
        </div>
        {d.modelVersions.length === 0 && <TurnitingFeedback state="empty" title="Sin modelos asociados" description="Todavía no hay modelos registrados para este dataset." className="documents-empty-state" layout="inline" />}
        <div className="dataset-model-grid">
          {d.modelVersions.map((m) => {
            const metrics = selectedMetrics(m.metrics)
            return (
              <article className="dataset-model-card" key={m.id}>
                <header>
                  <strong>{m.name}</strong>
                  <span className={`dataset-status dataset-status-${m.status.toLowerCase()}`}>{modelStatusLabel(m.status)}</span>
                </header>
                <p className="dataset-model-arch">{m.architecture}{m.variant ? ` · ${m.variant}` : ''}</p>
                <dl>
                  <div><dt>Primaria (val)</dt><dd>{formatMetric(metrics.primary)}</dd></div>
                  <div><dt>Test macro F1</dt><dd>{formatMetric(metrics.test)}</dd></div>
                  <div><dt>Español</dt><dd>{formatMetric(metrics.spanish)}</dd></div>
                  <div><dt>Académico</dt><dd>{formatMetric(metrics.academic)}</dd></div>
                  <div><dt>OOD</dt><dd>{formatMetric(metrics.ood)}</dd></div>
                  <div><dt>FPR test</dt><dd>{formatMetric(metrics.testFpr)}</dd></div>
                </dl>
                <p className="dataset-model-meta">Uso: <strong>{m.commercialEligibility}</strong> · Artefacto: {m.artifactProvider ?? '—'} {m.artifactPath ? `· ${m.artifactPath}` : ''} (no descargado)</p>
                {m.thresholds && <p className="dataset-model-meta">Umbrales registrados (no aplicados): {Object.entries(m.thresholds).map(([k, v]) => `${k} ${v ?? '—'}`).join(' · ')}</p>}
                {m.limitations.length > 0 && <ul className="dataset-model-limitations">{m.limitations.map((l) => <li key={l}>{l}</li>)}</ul>}
              </article>
            )
          })}
        </div>
      </section>

      <section className="documents-section" aria-labelledby="sources-title">
        <div className="documents-section-heading">
          <div><p className="eyebrow">PROCEDENCIA</p><h2 id="sources-title">Fuentes y licencias</h2></div>
          <span className="documents-section-meta">{sources.data?.length ?? 0} fuentes</span>
        </div>
        {sources.isError && <ApiErrorNotice error={sources.error} title="No se pudieron cargar las fuentes" />}
        {sources.data && (
          <div className="dataset-table-wrap">
            <table className="dataset-table">
              <thead><tr><th>Fuente</th><th>Estado</th><th>Licencia</th><th>Uso comercial</th><th>Disponibles</th><th>Usadas</th><th>Español</th><th>Académico</th><th>Peso</th></tr></thead>
              <tbody>
                {sources.data.map((s) => (
                  <tr key={s.id}>
                    <td>{s.sourceUrl ? <a href={s.sourceUrl} target="_blank" rel="noreferrer">{s.name}</a> : s.name}</td>
                    <td>{s.status}</td>
                    <td><span className={`dataset-license dataset-license-${s.licenseStatus.toLowerCase()}`}>{licenseStatusLabel(s.licenseStatus)}</span><small>{s.license ?? ''}</small></td>
                    <td>{s.commercialUseStatus}</td>
                    <td>{formatCount(s.rowsAvailable)}</td>
                    <td>{formatCount(s.rowsUsed)}</td>
                    <td>{formatCount(s.spanishRows)}</td>
                    <td>{formatCount(s.academicRows)}</td>
                    <td>{s.samplingWeight === null ? '—' : s.samplingWeight.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="documents-section" aria-labelledby="splits-title">
        <div className="documents-section-heading">
          <div><p className="eyebrow">SPLITS Y LEAKAGE</p><h2 id="splits-title">Particiones por grupo</h2></div>
          <span className="documents-section-meta">{formatCount(stats.data?.statistics?.groups ?? null)} grupos</span>
        </div>
        <div className="dataset-table-wrap">
          <table className="dataset-table">
            <thead><tr><th>Split</th><th>Filas</th><th>Manifiesto</th><th>SHA-256</th></tr></thead>
            <tbody>
              {d.splitManifests.map((s) => (
                <tr key={s.split}><td>{s.split}</td><td>{formatCount(s.rowCount)}</td><td>{s.manifestPath ?? '—'}</td><td className="dataset-hash">{s.sha256?.slice(0, 16) ?? '—'}…</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        {leakage && <pre className="dataset-leakage">{JSON.stringify(leakage, null, 2)}</pre>}
      </section>

      <section className="documents-section" aria-labelledby="artifacts-title">
        <div className="documents-section-heading">
          <div><p className="eyebrow">ARTEFACTOS</p><h2 id="artifacts-title">Manifiestos, reportes y shards</h2></div>
          <span className="documents-section-meta">{artifacts.data?.length ?? 0} artefactos</span>
        </div>
        {artifacts.data && (
          <div className="dataset-table-wrap">
            <table className="dataset-table">
              <thead><tr><th>Tipo</th><th>Almacenamiento</th><th>Ruta</th><th>Tamaño</th><th>SHA-256</th></tr></thead>
              <tbody>
                {artifacts.data.map((a) => (
                  <tr key={a.id}>
                    <td>{a.artifactType}</td>
                    <td>{a.storageProvider}{a.external ? ' · externo' : ''}</td>
                    <td className="dataset-path">{a.path}</td>
                    <td>{formatBytes(a.sizeBytes)}</td>
                    <td className="dataset-hash">{a.sha256 ? `${a.sha256.slice(0, 12)}…` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="documents-section" aria-labelledby="samples-title">
        <div className="documents-section-heading">
          <div><p className="eyebrow">MUESTRAS LOCALES</p><h2 id="samples-title">TrainingSample</h2></div>
          <span className="documents-section-meta">{samples.data?.total ?? 0} muestras · el texto privado nunca se muestra</span>
        </div>
        <div className="dataset-filters">
          {Object.entries(SAMPLE_FILTERS).map(([key, options]) => (
            <div className="dataset-filter-field" key={key}>
              <span>{key}</span>
              <CustomSelect
                id={`dataset-${key}-sample-filter`}
                label={`Filtro ${key}`}
                value={filters[key] ?? ''}
                options={options.map((o) => ({ value: o, label: o || 'todos' }))}
                onChange={(value) => setFilters({ ...filters, [key]: value })}
              />
            </div>
          ))}
        </div>
        {samples.isError && <ApiErrorNotice error={samples.error} title="No se pudieron cargar las muestras" />}
        {samples.data?.items.length === 0 && <TurnitingFeedback state="empty" title="Sin muestras para estos filtros" description="Prueba con otros filtros para consultar las muestras locales." className="documents-empty-state" layout="inline" />}
        {samples.data && samples.data.items.length > 0 && (
          <div className="dataset-table-wrap">
            <table className="dataset-table">
              <thead><tr><th>Etiqueta</th><th>Origen</th><th>Split</th><th>Idioma</th><th>Entrenable</th><th>Privacidad</th><th>Texto</th></tr></thead>
              <tbody>
                {samples.data.items.map((s) => (
                  <tr key={s.id}>
                    <td>{s.label}</td><td>{s.labelSource}</td><td>{s.split ?? '—'}</td><td>{s.language ?? '—'}</td>
                    <td>{s.eligibleForTraining ? 'sí' : 'no'}</td><td>{s.privacyClass}</td>
                    <td>{s.textRedacted ? <em>oculto (privado)</em> : (s.text ?? '').slice(0, 80)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
