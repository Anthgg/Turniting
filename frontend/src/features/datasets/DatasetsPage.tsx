import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { datasetQueryKeys, listDatasets } from '../../api/datasets'
import { ApiErrorNotice } from '../documents/ApiErrorNotice'
import { LicenseWarning } from './LicenseWarning'
import { datasetStatusLabel, formatCount } from './dataset-utils'

export function DatasetsPage() {
  const datasets = useQuery({ queryKey: datasetQueryKeys.list(), queryFn: listDatasets, retry: 1 })

  return (
    <div className="dashboard-main datasets-main">
      <div className="page-heading">
        <div>
          <p className="eyebrow">CATÁLOGO TÉCNICO</p>
          <h1>Datasets</h1>
          <p className="page-subtitle">Versiones registradas, procedencia, licencias y modelos asociados. Los datos masivos permanecen en Parquet fuera de la base de datos.</p>
        </div>
      </div>

      <section className="documents-section" aria-labelledby="datasets-list-title">
        <div className="documents-section-heading">
          <div>
            <p className="eyebrow">VERSIONES</p>
            <h2 id="datasets-list-title">Datasets registrados</h2>
          </div>
          <span className="documents-section-meta">{datasets.data?.total ?? 0} versiones</span>
        </div>
        {datasets.isError && <ApiErrorNotice error={datasets.error} title="No se pudieron cargar los datasets" />}
        {datasets.isPending && <div className="documents-empty-state" role="status"><span className="state-indicator is-animated" /><span>Cargando datasets…</span></div>}
        {datasets.data?.items.length === 0 && (
          <div className="documents-empty-state">
            <strong>Aún no hay datasets registrados</strong>
            <span>Registra TURNITING_DATASET_V1 con POST /api/datasets/register usando los manifests de training/.</span>
          </div>
        )}
        {datasets.data && datasets.data.items.length > 0 && (
          <div className="dataset-table-wrap">
            <table className="dataset-table">
              <thead>
                <tr>
                  <th>Dataset</th><th>Versión</th><th>Estado</th><th>Filas</th><th>Humano</th><th>Máquina</th>
                  <th>Español</th><th>Académico</th><th>Idiomas</th><th>Fuentes</th>
                </tr>
              </thead>
              <tbody>
                {datasets.data.items.map((d) => (
                  <tr key={d.id}>
                    <td><Link to={`/datasets/${d.id}`}>{d.name}</Link></td>
                    <td>{d.version}</td>
                    <td><span className={`dataset-status dataset-status-${d.status.toLowerCase()}`}>{datasetStatusLabel(d.status)}</span></td>
                    <td>{formatCount(d.totalRows)}</td>
                    <td>{formatCount(d.humanRows)}</td>
                    <td>{formatCount(d.machineRows)}</td>
                    <td>{formatCount(d.spanishRows)}</td>
                    <td>{formatCount(d.academicRows)}</td>
                    <td>{formatCount(d.languageCount)}</td>
                    <td>{d._count.sources}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {datasets.data?.items.map((d) => (
          d.licenseWarnings.message ? <div key={`w-${d.id}`} className="dataset-warning-row"><span className="dataset-warning-label">{d.displayName}</span><LicenseWarning warnings={d.licenseWarnings} /></div> : null
        ))}
      </section>
    </div>
  )
}
