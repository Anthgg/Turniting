import { z } from 'zod'

const configuredBaseUrl = import.meta.env.VITE_API_URL?.trim()
const apiBaseUrl = (configuredBaseUrl || '/api').replace(/\/$/, '')

export class ApiRequestError extends Error {
  readonly status: number
  readonly code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
  }
}

function requestUrl(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${apiBaseUrl}${normalizedPath}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function asMessage(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value
  if (Array.isArray(value)) {
    const messages = value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    if (messages.length) return messages.join(' · ')
  }
  return undefined
}

async function readError(response: Response): Promise<ApiRequestError> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }

  const body = asRecord(payload)
  const nestedError = asRecord(body?.error)
  const statusCode = typeof body?.statusCode === 'number' ? body.statusCode : response.status
  const code = [body?.code, body?.errorCode, body?.error_code, nestedError?.code]
    .find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    ?? (typeof body?.error === 'string' && body.error.trim() ? body.error : undefined)
  const message = asMessage(body?.message)
    ?? asMessage(nestedError?.message)
    ?? `La solicitud no pudo completarse (HTTP ${statusCode}).`

  return new ApiRequestError(message, statusCode, code)
}

async function requestJson<T>(path: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(requestUrl(path), {
    ...init,
    headers: {
      Accept: 'application/json',
      ...init.headers,
    },
    credentials: 'same-origin',
  })

  if (!response.ok) throw await readError(response)

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ApiRequestError('La API devolvió una respuesta que no es JSON válido.', response.status)
  }

  const result = schema.safeParse(payload)
  if (!result.success) {
    throw new ApiRequestError('La respuesta de la API no tiene el formato esperado.', response.status)
  }

  return result.data
}

export function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return requestJson(path, { method: 'GET' }, schema)
}

export function postJson<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  return requestJson(path, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, schema)
}

export function postFile<T>(path: string, file: File, schema: z.ZodType<T>): Promise<T> {
  const form = new FormData()
  form.append('file', file)
  return requestJson(path, { method: 'POST', body: form }, schema)
}

export async function deleteResource(path: string): Promise<void> {
  const response = await fetch(requestUrl(path), {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  })

  if (!response.ok) throw await readError(response)
}
