import { useQuery } from '@tanstack/react-query'
import { analysisQueryKeys, listAnalyzerModels } from '../../api/analysis'
import { ApiErrorNotice } from '../documents/ApiErrorNotice'
import { availabilityLabel } from './analysis-utils'

export function ModelsPage() {
  const models = useQuery({ queryKey: analysisQueryKeys.models(), queryFn: listAnalyzerModels, retry: 1 })
  return (
    <div className="dashboard-main">
      <div className="page-heading">
        <div>
          <p className="eyebrow">ANALIZADOR LOCAL</p>
          <h1>Modelos</h1>
          <p className="page-subtitle">Modelos candidatos registrados y disponibilidad de sus pesos en este equipo. Ninguno está activado como producción.</p>
        </div>
      </div>
      {models.isError && <ApiErrorNotice error={models.error} title="No se pudo cargar el registro de modelos" />}
      {models.data && !models.data.aiServiceReachable && <p className="analysis-notice">El servicio de IA no responde; se muestra solo el registro.</p>}
      <div className="dataset-model-grid">
        {models.data?.items.map((m) => (
          <article key={m.name} className="dataset-model-card">
            <header>
              <strong>{m.name}</strong>
              <span className={`dataset-status ${m.availability === 'READY' || m.availability === 'AVAILABLE' ? 'dataset-status-ready' : 'dataset-status-draft'}`}>
                {availabilityLabel(m.availability)}
              </span>
            </header>
            <p className="dataset-model-arch">{m.architecture ?? '—'}{m.variant ? ` · ${m.variant}` : ''}</p>
            <p className="dataset-model-meta">Estado: <strong>{m.status ?? '—'}</strong> · Dataset: {m.dataset ?? '—'} · {m.registeredInDatabase ? 'registrado en la base de datos' : 'sin registrar en la base de datos'}</p>
            <p className="dataset-model-meta">Preprocesamiento: {m.preprocessing.join(' + ') || '—'} · Perfiles: {m.thresholdProfiles.join(', ') || '—'}</p>
            {m.warnings.length > 0 && <ul className="dataset-model-limitations">{m.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          </article>
        ))}
      </div>
    </div>
  )
}
