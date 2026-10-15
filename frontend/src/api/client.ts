import { z } from 'zod'

const configuredBaseUrl = import.meta.env.VITE_API_URL?.trim()
const apiBaseUrl = (configuredBaseUrl || '/api').replace(/\/$/, '')

export class ApiRequestError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
  }
}

export async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const response = await fetch(`${apiBaseUrl}${normalizedPath}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  })

  if (!response.ok) {
    throw new ApiRequestError(`La API respondió con el estado ${response.status}.`, response.status)
  }

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
