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
  queryMocks.useQuery.mockReturnValue({
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

  it('keeps the Mac-style bottom dock, Turniting brand and compact mobile entry point', () => {
    const html = renderLayout('/')

    expect(html).toContain('class="bottom-dock"')
    expect(html).toContain('dock-core-item')
    expect(html).toContain('dock-secondary-item')
    expect(html).toContain('dock-mobile-more')
    expect(html).toContain('class="topbar"')
    expect(html).toContain('class="topbar-brand"')
    expect(html).toContain('Turniting, ir al inicio')
    expect(html).toContain('aria-label="Navegación principal"')
    expect(html).toContain('href="/documents"')
    expect(html).toContain('Análisis rápido')
    expect(html).toContain('aria-label="Historial de análisis"')
    expect(html).toContain('aria-label="Reportes Turniting"')
    expect(html).toContain('Estado técnico')
    expect(html).not.toContain('app-sidebar')
    expect(html).not.toContain('Área académica')
  })

  it('marks current document, quick analysis, and review destinations', () => {
    const docsHtml = renderLayout('/documents')
    expect(docsHtml).toContain('aria-label="Documentos" data-tooltip="Documentos" aria-current="page" class="dock-item dock-core-item is-active" href="/documents"')
    expect(docsHtml).toContain('breadcrumb-current" aria-current="page" title="Analizar documento">Analizar documento<')

    const quickHtml = renderLayout('/analysis/quick')
    expect(quickHtml).toContain('aria-label="Análisis rápido" data-tooltip="Análisis rápido" aria-current="page" class="dock-item dock-core-item is-active" href="/analysis/quick"')

    const historyHtml = renderLayout('/history')
    expect(historyHtml).toContain('aria-label="Historial de análisis" data-tooltip="Historial de análisis" aria-current="page" class="dock-item dock-secondary-item is-active" href="/history"')
    expect(historyHtml).toContain('breadcrumb-current" aria-current="page" title="Historial de análisis">Historial de análisis<')

    const reviewHtml = renderLayout('/documents/79e92350-c705-486d-bc56-8d431e41bf7a')
    expect(reviewHtml).toContain('aria-label="Revisión IA" aria-current="page"')
    expect(reviewHtml).toContain('synthetic-example.docx')
  })

  it('marks a tool in the mobile More menu as current without duplicating the desktop sidebar', () => {
    const html = renderLayout('/models')
    expect(html).toContain('aria-label="Modelos" data-tooltip="Modelos" aria-current="page" class="dock-item dock-secondary-item is-active"')
    expect(html).toContain('class="dock-item dock-mobile-more is-active"')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).not.toContain('sidebar-navigation')
  })
})
