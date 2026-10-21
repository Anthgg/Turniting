import { listDocumentAnalyses } from '../../api/analysis'
import { listDocuments } from '../../api/documents'

type AnalysisRun = Awaited<ReturnType<typeof listDocumentAnalyses>>['items'][number]
type DocumentItem = Awaited<ReturnType<typeof listDocuments>>['items'][number]

export type AnalysisHistoryEntry = { document: DocumentItem; run: AnalysisRun }

export const analysisHistoryQueryKeys = {
  page: (page: number, pageSize: number) => ['analysis-history', page, pageSize] as const,
}

export async function loadAnalysisHistory(page = 1, pageSize = 12) {
  const documents = await listDocuments(page, pageSize)
  const results = await Promise.all(documents.items.map(async (document) => {
    try {
      const history = await listDocumentAnalyses(document.id)
      return { entries: history.items.map((run) => ({ document, run })), failed: false }
    } catch {
      return { entries: [] as AnalysisHistoryEntry[], failed: true }
    }
  }))

  const entries = results.flatMap((result) => result.entries)
    .sort((left, right) => Date.parse(right.run.createdAt) - Date.parse(left.run.createdAt))

  return {
    entries,
    documentCount: documents.total,
    totalPages: Math.max(1, Math.ceil(documents.total / pageSize)),
    failedDocuments: results.filter((result) => result.failed).length,
  }
}
