import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryMocks = vi.hoisted(() => ({ useQuery: vi.fn(), useQueries: vi.fn() }))

vi.mock('@tanstack/react-query', () => queryMocks)
vi.mock('./DocumentUpload', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    DocumentUpload: () => React.createElement(
      'section',
      { 'aria-label': 'Carga de archivos' },
      React.createElement('span', { role: 'status', 'aria-live': 'polite' }, 'Archivo seleccionado: borrador.pdf'),
    ),
  }
})

import { DocumentListPage } from './DocumentListPage'

function summary(status: 'UPLOADED' | 'PROCESSING' | 'EXTRACTED' | 'OCR_REQUIRED' | 'FAILED', id: string, originalName: string) {
  return {
    id,
    originalName,
    status,
    sizeBytes: 2048,
    createdAt: '2026-10-21T12:00:00.000Z',
    extension: 'pdf',
  }
}

function renderPage(queryState: Record<string, unknown>) {
  queryMocks.useQuery.mockReturnValue(queryState)
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    null,
    createElement(DocumentListPage),
  ))
}

describe('DocumentListPage', () => {
  beforeEach(() => {
    queryMocks.useQuery.mockReset()
    queryMocks.useQueries.mockReset().mockReturnValue([])
  })

  it('keeps the uploader slot and exposes its selected-file status accessibly', () => {
    const html = renderPage({ isPending: true, isFetching: true, refetch: vi.fn() })

    expect(html).toContain('<h1>Documentos</h1>')
    expect(html).toContain('aria-label="Carga de archivos"')
    expect(html).toContain('role="status" aria-live="polite"')
    expect(html).toContain('Archivo seleccionado: borrador.pdf')
    expect(html).toContain('Cargando documentos…')
  })

  it('shows analysis as the primary action only when extraction is complete and preserves document routes', () => {
    const html = renderPage({
      data: {
        items: [
          summary('EXTRACTED', 'doc-ready', 'ensayo-final.pdf'),
          summary('PROCESSING', 'doc-processing', 'capitulo.pdf'),
          summary('OCR_REQUIRED', 'doc-ocr', 'escaneo.pdf'),
          summary('FAILED', 'doc-failed', 'fallido.pdf'),
        ],
        page: 1,
        limit: 10,
        total: 4,
        totalPages: 1,
      },
      isPending: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(),
    })

    expect(html).toContain('aria-label="Analizar documento: ensayo-final.pdf"')
    expect(html).toContain('href="/documents/doc-ready"')
    expect(html).toContain('aria-label="Ver estado: capitulo.pdf"')
    expect(html).toContain('aria-label="Revisar OCR: escaneo.pdf"')
    expect(html).toContain('aria-label="Revisar documento: fallido.pdf"')
    expect(html).toContain('Procesando')
    expect(html).toContain('OCR requerido')
    expect(html).toContain('Error')
    expect(html).toContain('aria-label="Paginación de documentos"')
  })

  it('surfaces real latest analysis values without adding scores when no result exists', () => {
    queryMocks.useQueries.mockReturnValue([
      {
        data: {
          items: [{
            status: 'COMPLETED',
            createdAt: '2026-10-21T12:10:00.000Z',
            documentScore: 0.434,
            documentScorePercent: 43,
            scoredSegments: 4,
            evaluatedSegments: 4,
            flaggedSegments: 2,
            analyzerMode: 'F006_1_1_ONLY',
          }],
        },
        isPending: false,
        isError: false,
      },
      { data: { items: [] }, isPending: false, isError: false },
      { data: { items: [] }, isPending: false, isError: false },
      { data: { items: [] }, isPending: false, isError: false },
      { data: { items: [] }, isPending: false, isError: false },
    ])
    const html = renderPage({
      data: {
        items: [
          summary('EXTRACTED', 'doc-ready', 'ensayo-final.pdf'),
          summary('EXTRACTED', 'doc-empty', 'sin-analisis.pdf'),
          summary('PROCESSING', 'doc-processing', 'capitulo.pdf'),
          summary('OCR_REQUIRED', 'doc-ocr', 'escaneo.pdf'),
          summary('FAILED', 'doc-failed', 'fallido.pdf'),
        ],
        page: 1,
        limit: 10,
        total: 4,
        totalPages: 1,
      },
      isPending: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(),
    })

    expect(html).toMatch(/43[,.]4 %/)
    expect(html).toContain('4 evaluados')
    expect(html).toContain('2 señalados')
    expect(html).toContain('F006.1.1 · Experimental')
    expect(html).toContain('Aún no hay análisis')
    expect(html).not.toContain('0 %')
  })

  it('announces an empty library accessibly', () => {
    const html = renderPage({
      data: { items: [], page: 1, limit: 10, total: 0, totalPages: 0 },
      isPending: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(),
    })

    expect(html).toContain('role="status" aria-live="polite"')
    expect(html).toContain('Aún no hay documentos')
  })

  it('disables refresh and paging while the document list is fetching', () => {
    const html = renderPage({
      data: {
        items: [summary('EXTRACTED', 'doc-ready', 'ensayo-final.pdf')],
        page: 1,
        limit: 10,
        total: 11,
        totalPages: 2,
      },
      isPending: false,
      isFetching: true,
      isError: false,
      refetch: vi.fn(),
    })

    expect(html).toContain('aria-label="Actualizar lista de documentos"')
    expect(html).toContain('aria-busy="true"')
    expect(html.match(/disabled=""/g)).toHaveLength(3)
  })
})
