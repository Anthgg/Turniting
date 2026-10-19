/** Neutral presentation helpers for the AI-signal analyzer (no accusatory wording). */

export type SignalLevel = 'LOW' | 'MODERATE' | 'HIGH'
export const DEFAULT_PARAGRAPH_MODE = 'STRICT_PARAGRAPH' as const

export const OPERATION_ERROR_MESSAGE = {
  analysisError: 'No se pudo completar el análisis solicitado.',
  segmentsError: 'No se pudieron cargar los párrafos de este análisis.',
  historyError: 'No se pudo cargar el historial de análisis.',
  comparisonError: 'No se pudo completar la comparación solicitada.',
  modelStatusError: 'No se pudo consultar el registro local de modelos.',
  uploadError: 'No se pudo subir el documento.',
} as const

export type AnalysisOperationError = keyof typeof OPERATION_ERROR_MESSAGE

export function operationErrorMessage(operation: AnalysisOperationError): string {
  return OPERATION_ERROR_MESSAGE[operation]
}

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
  F006_1_ONLY: 'F006.1 · Experimental',
  F006_1_1_ONLY: 'F006.1.1 · Experimental',
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

export function toDisplayPercent(score: number | null | undefined): number | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null
  return Math.round(score * 100)
}

export function formatPercentPoints(points: number | null | undefined): string {
  if (points === null || points === undefined || !Number.isFinite(points)) return '—'
  return `${Math.round(points)} %`
}

export function formatPercent(score: number | null | undefined): string {
  return formatPercentPoints(toDisplayPercent(score))
}

export function formatSignal(score: number | null | undefined): string {
  return formatPercent(score)
}

export function formatDelta(delta: number | null | undefined): string {
  const pp = toDisplayPercent(delta)
  if (pp === null) return '—'
  return `${pp > 0 ? '+' : ''}${pp} pp`
}

export function selectAnalysisRun<T extends { id: string }>(
  history: T[],
  selectedId: string | null | undefined,
): T | undefined {
  if (selectedId) {
    const selected = history.find((item) => item.id === selectedId)
    if (selected) return selected
  }
  return history[0]
}

export function segmentsBelongToRun(
  runId: string | null | undefined,
  segments: { analysisId: string } | null | undefined,
): boolean {
  return Boolean(runId && segments && segments.analysisId === runId)
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
  return state === 'READY' || state === 'AVAILABLE' || state === 'COMPOSITE_AVAILABLE'
}

export function analysisErrorMessage(code: string | undefined, status: number | undefined): string {
  if (code === 'MODEL_UNAVAILABLE' || status === 503) {
    return 'El modelo seleccionado no está disponible en este servidor (faltan sus pesos). El resto de la aplicación sigue funcionando.'
  }
  if (status === 429) return 'El analizador está ocupado con otro documento. Inténtalo de nuevo en unos minutos.'
  if (status === 409) return 'El documento todavía no tiene texto extraído para analizar.'
  return 'No se pudo completar el análisis.'
}

export type ParagraphDisplayItem<TSegment extends { paragraphIndex: number; classification: string }> =
  | { type: 'single'; segment: TSegment }
  | {
      type: 'insufficient-group'
      groupKey: string
      startIndex: number
      endIndex: number
      items: TSegment[]
    }

export function groupParagraphSegments<TSegment extends { paragraphIndex: number; classification: string }>(
  items: TSegment[],
  enableCompaction: boolean,
): ParagraphDisplayItem<TSegment>[] {
  if (!enableCompaction || items.length === 0) {
    return items.map((segment) => ({ type: 'single', segment }))
  }

  const result: ParagraphDisplayItem<TSegment>[] = []
  let index = 0

  while (index < items.length) {
    const current = items[index]
    if (current.classification === 'INSUFFICIENT_TEXT') {
      const runItems: TSegment[] = [current]
      let nextIndex = index + 1
      while (nextIndex < items.length && items[nextIndex].classification === 'INSUFFICIENT_TEXT') {
        runItems.push(items[nextIndex])
        nextIndex += 1
      }

      if (runItems.length >= 2) {
        const startIndex = runItems[0].paragraphIndex
        const endIndex = runItems[runItems.length - 1].paragraphIndex
        result.push({
          type: 'insufficient-group',
          groupKey: `${startIndex}-${endIndex}`,
          startIndex,
          endIndex,
          items: runItems,
        })
      } else {
        result.push({ type: 'single', segment: current })
      }
      index = nextIndex
    } else {
      result.push({ type: 'single', segment: current })
      index += 1
    }
  }

  return result
}

