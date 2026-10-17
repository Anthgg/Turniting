export function formatCount(value: number | null | undefined) {
  return value === null || value === undefined ? '—' : value.toLocaleString('es-PE')
}

export function formatMetric(value: unknown) {
  return typeof value === 'number' ? value.toFixed(3) : '—'
}

export function formatBytes(value: number | null | undefined) {
  if (value === null || value === undefined) return '—'
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)} GB`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)} KB`
  return `${value} B`
}

export function datasetStatusLabel(status: string) {
  const labels: Record<string, string> = {
    DRAFT: 'Borrador', BUILDING: 'Construyendo', READY: 'Listo', INVALID: 'Inválido', ARCHIVED: 'Archivado',
  }
  return labels[status] ?? status
}

export function licenseStatusLabel(status: string) {
  const labels: Record<string, string> = {
    ALLOWED: 'Permitida', NON_COMMERCIAL_ONLY: 'Solo no comercial', UNDECLARED: 'No declarada',
    RESTRICTED: 'Restringida', UNKNOWN: 'Desconocida', BLOCKED: 'Bloqueada',
  }
  return labels[status] ?? status
}

export function modelStatusLabel(status: string) {
  const labels: Record<string, string> = {
    EXPERIMENTAL: 'Experimental', CANDIDATE: 'Candidato', ACTIVE: 'Activo', RETIRED: 'Retirado', INVALID: 'Inválido',
  }
  return labels[status] ?? status
}

/** Picks the reported metrics without assuming every model exposes the same keys. */
export function selectedMetrics(metrics: Record<string, unknown>) {
  const final = (metrics.final ?? {}) as Record<string, Record<string, unknown> | undefined>
  return {
    primary: metrics.selection_primary,
    test: final.test?.macro_f1,
    spanish: final.spanish_test?.macro_f1,
    academic: final.academic_test?.macro_f1,
    ood: final.ood?.macro_f1,
    testFpr: final.test?.fpr,
  }
}
