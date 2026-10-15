import { z } from 'zod'
import { deleteResource, getJson, postFile, postJson } from './client'

export const documentStatusSchema = z.enum([
  'UPLOADED',
  'PROCESSING',
  'EXTRACTED',
  'OCR_REQUIRED',
  'FAILED',
])

export type DocumentStatus = z.infer<typeof documentStatusSchema>

const nullableCount = z.number().int().nonnegative().nullable()

export const documentSchema = z.object({
  id: z.string().min(1),
  documentVersionId: z.string().uuid().nullable().optional(),
  originalName: z.string().min(1),
  mimeType: z.string(),
  extension: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
  status: documentStatusSchema,
  pageCount: nullableCount,
  wordCount: nullableCount,
  characterCount: nullableCount,
  requiresOcr: z.boolean(),
  extractionError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  textPreview: z.string().max(2000).optional(),
  warnings: z.array(z.string()).default([]),
}).passthrough()

export type DocumentRecord = z.infer<typeof documentSchema>

const documentSummarySchema = z.object({
  id: z.string().min(1),
  originalName: z.string().min(1),
  status: documentStatusSchema,
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.string(),
  extension: z.string().optional(),
  requiresOcr: z.boolean().optional(),
}).passthrough()

export type DocumentSummary = z.infer<typeof documentSummarySchema>

const documentListSchema = z.object({
  items: z.array(documentSummarySchema),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
}).passthrough()

const uploadDocumentResponseSchema = z.union([
  documentSchema,
  z.object({ document: documentSchema }).passthrough().transform(({ document }) => document),
])

export const documentTextSchema = z.object({
  documentId: z.string().min(1),
  text: z.string(),
  wordCount: z.number().int().nonnegative(),
  characterCount: z.number().int().nonnegative(),
}).passthrough()

export type DocumentText = z.infer<typeof documentTextSchema>

export const documentQueryKeys = {
  all: ['documents'] as const,
  list: (page: number, limit: number) => ['documents', 'list', { page, limit }] as const,
  detail: (id: string) => ['documents', 'detail', id] as const,
  text: (id: string) => ['documents', 'text', id] as const,
}

export function listDocuments(page: number, limit: number) {
  const query = new URLSearchParams({ page: String(page), limit: String(limit) })
  return getJson(`/documents?${query.toString()}`, documentListSchema)
}

export function getDocument(id: string) {
  return getJson(`/documents/${encodeURIComponent(id)}`, documentSchema)
}

export function getDocumentText(id: string) {
  return getJson(`/documents/${encodeURIComponent(id)}/text`, documentTextSchema)
}

export function uploadDocument(file: File) {
  return postFile(`/documents`, file, uploadDocumentResponseSchema)
}

export function deleteDocument(id: string) {
  return deleteResource(`/documents/${encodeURIComponent(id)}`)
}

export function reprocessDocument(id: string) {
  return postJson(`/documents/${encodeURIComponent(id)}/reprocess`, uploadDocumentResponseSchema)
}
