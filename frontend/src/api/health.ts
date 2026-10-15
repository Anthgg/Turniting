import { z } from 'zod'
import { getJson } from './client'

export const healthResponseSchema = z.object({
  status: z.string(),
  service: z.string().optional(),
  database: z.string().optional(),
  aiService: z.string().optional(),
}).passthrough()

export type HealthResponse = z.infer<typeof healthResponseSchema>
export type HealthService = 'backend' | 'database' | 'ai'

const healthPaths: Record<HealthService, string> = {
  backend: '/health',
  database: '/health/db',
  ai: '/health/ai',
}

export function getHealth(service: HealthService): Promise<HealthResponse> {
  return getJson(healthPaths[service], healthResponseSchema)
}
