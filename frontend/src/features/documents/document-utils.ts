import { ApiRequestError } from '../../api/client'
import type { DocumentStatus } from '../../api/documents'

const statusLabels: Record<DocumentStatus, string> = {
  UPLOADED: 'Cargado',
  PROCESSING: 'Procesando',
  EXTRACTED: 'Completado',
  OCR_REQUIRED: 'OCR requerido',
  FAILED: 'Error',
}

export function statusLabel(status: DocumentStatus) {
  return statusLabels[status]
}

export function statusClass(status: DocumentStatus) {
  return `document-status document-status-${status.toLowerCase().replace('_', '-')}`
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('es-PE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

export function errorPresentation(error: unknown) {
  if (error instanceof ApiRequestError) {
    return {
      code: error.code ?? `HTTP_${error.status}`,
      message: error.message,
    }
  }
  if (error instanceof Error) {
    return { code: 'NETWORK_ERROR', message: error.message || 'No se pudo conectar con el backend.' }
  }
  return { code: 'UNKNOWN_ERROR', message: 'No se pudo completar la operación.' }
}
