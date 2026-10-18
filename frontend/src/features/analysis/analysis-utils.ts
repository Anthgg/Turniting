/** Neutral presentation helpers for the AI-signal analyzer (no accusatory wording). */

export type SignalLevel = 'LOW' | 'MODERATE' | 'HIGH'

export function signalLevel(score: number | null | undefined): SignalLevel | null {
  if (score === null || score === undefined || Number.isNaN(score)) return null
  if (score < 0.35) return 'LOW'
  if (score < 0.65) return 'MODERATE'
  return 'HIGH'
}

export const SIGNAL_LABEL: Record<SignalLevel, string> = {
  LOW: 'Señal baja',
  MODERATE: 'Señal moderada',
  HIGH: 'Señal alta',
}

export const ANALYZER_LABEL: Record<string, string> = {
  V3_ONLY: 'Modelo V3',
  V2_ONLY: 'Modelo V2 (referencia)',
  ENSEMBLE: 'Combinación V2 + V3',
}

export const PROFILE_LABEL: Record<string, string> = {
  BALANCED: 'Equilibrado',
  LOW_FALSE_POSITIVE: 'Pocos falsos positivos',
  VERY_LOW_FALSE_POSITIVE: 'Muy pocos falsos positivos',
  CUSTOM: 'Personalizado',
}

export const COMPARISON_LABEL: Record<string, string> = {
  UNCHANGED: 'Sin cambios',
  MODIFIED: 'Modificado',
  ADDED: 'Añadido',
  REMOVED: 'Eliminado',
}

export function formatSignal(score: number | null | undefined): string {
  if (score === null || score === undefined || Number.isNaN(score)) return '—'
  return `${Math.round(score * 100)} %`
}

export function formatDelta(delta: number | null | undefined): string {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return '—'
  const pp = Math.round(delta * 100)
  return `${pp > 0 ? '+' : ''}${pp} pp`
}

export function availabilityLabel(state: string): string {
  switch (state) {
    case 'READY': return 'Cargado'
    case 'AVAILABLE': return 'Disponible'
    case 'COMPOSITE_AVAILABLE': return 'Disponible · combinación V2 + V3'
    case 'LOADING': return 'Cargando'
    case 'ERROR': return 'Error en artefacto'
    case 'AI_SERVICE_UNREACHABLE': return 'Servicio de IA no disponible'
    case 'DEPENDENCIES_UNAVAILABLE': return 'Componentes no disponibles'
    case 'UNAVAILABLE': return 'No disponible'
    default: return 'Estado desconocido'
  }
}

export function isAnalyzerUsable(state: string): boolean {
  return state === 'READY' || state === 'AVAILABLE'
}

export function analysisErrorMessage(code: string | undefined, status: number | undefined): string {
  if (code === 'MODEL_UNAVAILABLE' || status === 503) {
    return 'El modelo seleccionado no está disponible en este servidor (faltan sus pesos). El resto de la aplicación sigue funcionando.'
  }
  if (status === 429) return 'El analizador está ocupado con otro documento. Inténtalo de nuevo en unos minutos.'
  if (status === 409) return 'El documento todavía no tiene texto extraído para analizar.'
  return 'No se pudo completar el análisis.'
}
