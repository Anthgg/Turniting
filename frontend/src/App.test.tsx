import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryMocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
}))

vi.mock('@tanstack/react-query', () => queryMocks)

import { WorkspaceLayout } from './App'

function renderLayout(initialPath: string, activeDocName = 'synthetic-example.docx') {
  queryMocks.useQuery
    .mockReturnValueOnce({
      data: {
        items: [
          {
            id: '79e92350-c705-486d-bc56-8d431e41bf7a',
            originalName: activeDocName,
            status: 'EXTRACTED',
            sizeBytes: 344000,
            createdAt: '2026-10-18T00:00:00.000Z',
            extension: 'docx',
          },
        ],
        page: 1,
        limit: 5,
        total: 1,
        totalPages: 1,
      },
      isError: false,
    })
    .mockReturnValueOnce({
      data: initialPath.startsWith('/documents/')
        ? {
            id: '79e92350-c705-486d-bc56-8d431e41bf7a',
            originalName: activeDocName,
            status: 'EXTRACTED',
            sizeBytes: 344000,
            createdAt: '2026-10-18T00:00:00.000Z',
            updatedAt: '2026-10-18T00:00:00.000Z',
            extension: 'docx',
          }
        : undefined,
      isError: false,
    })

  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [initialPath] },
      createElement(
        Routes,
        null,
        createElement(
          Route,
          { path: '*', element: createElement(WorkspaceLayout) },
        ),
      ),
    ),
  )
}

describe('F009.5 workspace navigation shell', () => {
  beforeEach(() => {
    queryMocks.useQuery.mockReset()
  })

  it('renders grouped sidebar navigation and removes the floating bottom dock', () => {
    const html = renderLayout('/')

    expect(html).toContain('class="app-sidebar"')
    expect(html).toContain('class="sidebar-navigation"')
    expect(html).toContain('class="topbar"')
    expect(html).toContain('Turniting')
    expect(html).toContain('aria-label="Navegación principal"')
    expect(html).toContain('Analizar documento')
    expect(html).toContain('Análisis rápido')
    expect(html).toContain('aria-label="Historial de análisis"')
    expect(html).toContain('aria-label="Reportes"')
    expect(html).toContain('Estado local')
    expect(html).not.toContain('bottom-dock')
    expect(html).not.toContain('Área académica')
  })

  it('marks current document, quick analysis, and review destinations', () => {
    const docsHtml = renderLayout('/documents')
    expect(docsHtml).toContain('aria-label="Analizar documento" title="Analizar documento" aria-current="page" class="sidebar-link is-active" href="/documents"')
    expect(docsHtml).toContain('breadcrumb-current" aria-current="page" title="Analizar documento">Analizar documento<')

    const quickHtml = renderLayout('/analysis/quick')
    expect(quickHtml).toContain('aria-label="Análisis rápido" title="Análisis rápido" aria-current="page" class="sidebar-link is-active" href="/analysis/quick"')

    const historyHtml = renderLayout('/history')
    expect(historyHtml).toContain('aria-label="Historial de análisis" title="Historial de análisis" aria-current="page" class="sidebar-link is-active" href="/history"')
    expect(historyHtml).toContain('breadcrumb-current" aria-current="page" title="Historial de análisis">Historial de análisis<')

    const reviewHtml = renderLayout('/documents/79e92350-c705-486d-bc56-8d431e41bf7a')
    expect(reviewHtml).toContain('aria-label="Revisión" aria-current="page"')
    expect(reviewHtml).toContain('synthetic-example.docx')
  })
})
