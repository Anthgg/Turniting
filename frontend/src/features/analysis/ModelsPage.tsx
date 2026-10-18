import { useQuery } from '@tanstack/react-query'
import { analysisQueryKeys, listAnalyzerModels } from '../../api/analysis'
import { ApiErrorNotice } from '../documents/ApiErrorNotice'
import { availabilityLabel } from './analysis-utils'

function percent(value: number | null | undefined) {
  return value == null ? '—' : `${(value * 100).toFixed(2)} %`
}

function displayWarning(warning: string) {
  if (warning === 'SPANISH_FPR_REGRESSION') return 'La tasa de falsos positivos en humanos en español es elevada.'
  if (warning === 'SPANISH_VALIDATION_SHIFT') return 'El resultado en español cambió entre validación y holdout.'
  return warning
}

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
      {models.data && <p className="analysis-notice">
        ACTIVE = <strong>{models.data.activeModel ?? 'NONE'}</strong>. Recomendación de desarrollo (no ACTIVE):{' '}
        {models.data.recommendedExperimentalAnalyzer ?? '—'} · {models.data.recommendedExperimentalThresholdProfile ?? '—'}.{' '}
        Alternativa de baja tasa de falsos positivos: {models.data.lowFprAlternative ?? '—'} ·{' '}
        {models.data.lowFprAlternativeThresholdProfile ?? '—'}.
      </p>}
      <div className="dataset-model-grid">
        {models.data?.items.map((m) => (
          <article key={m.name} className="dataset-model-card">
            <header>
              <strong>{m.name}</strong>
              <span className={`dataset-status ${m.availability === 'READY' || m.availability === 'AVAILABLE' || m.availability === 'COMPOSITE_AVAILABLE' ? 'dataset-status-ready' : 'dataset-status-draft'}`}>
                {availabilityLabel(m.availability)}
              </span>
            </header>
            <p className="dataset-model-arch">{m.architecture ?? '—'}{m.variant ? ` · ${m.variant}` : ''}</p>
            <p className="dataset-model-meta">Estado: <strong>{m.status ?? '—'}</strong> · Dataset de referencia: {m.dataset ?? '—'} · Registro del modelo: {m.registeredInDatabase ? 'en la base de datos' : 'solo en el catálogo'}</p>
            <p className="dataset-model-meta">Preprocesamiento: {m.preprocessing.join(' + ') || '—'} · Perfiles: {m.thresholdProfiles.join(', ') || '—'}</p>
            <p className="dataset-model-meta">Pesos locales: {m.artifactPresent ? (m.artifactValid ? 'disponibles y válidos' : 'presentes, con validación pendiente') : 'no disponibles'}</p>
            {m.metrics && <>
              <p className="dataset-model-meta"><strong>Holdout {m.metrics.operatingPoint}</strong> · macro-F1 {m.metrics.macroF1.toFixed(4)} · FPR humanos: general {percent(m.metrics.overallHumanFpr)}, español {percent(m.metrics.spanishHumanFpr)}, académico {percent(m.metrics.academicHumanFpr)}, generador no visto {percent(m.metrics.unseenGeneratorHumanFpr)}.</p>
              <p className="dataset-model-meta">Mixto: recall {percent(m.metrics.mixedRecall)} · AI-edited: F1 {m.metrics.aiEditedF1.toFixed(4)} · OOD: F1 {m.metrics.oodF1.toFixed(4)} · robustez: zero-width {m.metrics.zeroWidthF1.toFixed(4)}, homoglyph {m.metrics.homoglyphF1.toFixed(4)}{m.metrics.spanTokenF1 == null ? '' : `, span token F1 ${m.metrics.spanTokenF1.toFixed(3)}`}.</p>
            </>}
            {m.activeGateResults?.spanishHumanFpr && <p className="dataset-model-meta">Gate de FPR humano en español: <strong>{m.activeGateResults.spanishHumanFpr.passed ? 'PASS' : 'FAIL'}</strong> · {percent(m.activeGateResults.spanishHumanFpr.observed)} / límite {percent(m.activeGateResults.spanishHumanFpr.limit)}.</p>}
            {m.strengths && m.strengths.length > 0 && <ul className="dataset-model-limitations">{m.strengths.map((strength) => <li key={strength}>{strength}</li>)}</ul>}
            {m.warnings.length > 0 && <ul className="dataset-model-limitations">{[...new Set(m.warnings.map(displayWarning))].map((w) => <li key={w}>{w}</li>)}</ul>}
          </article>
        ))}
      </div>
    </div>
  )
}
