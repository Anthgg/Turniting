import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryMocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
}))

vi.mock('@tanstack/react-query', () => queryMocks)

import { WorkspaceLayout } from './App'

function renderLayout(initialPath: string, activeDocName = 'TESIS_EC_sin_Turnitin.docx') {
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

describe('F006.2.4 Top Bar + Floating Bottom Dock Layout', () => {
  beforeEach(() => {
    queryMocks.useQuery.mockReset()
  })

  it('completely removes the left sidebar and renders the top bar and floating bottom dock', () => {
    const html = renderLayout('/')

    expect(html).not.toContain('class="sidebar"')
    expect(html).not.toContain('<aside')
    expect(html).toContain('class="topbar"')
    expect(html).toContain('Turniting')
    expect(html).toContain('Área académica')
    expect(html).toContain('Entorno local')
    expect(html).toContain('class="bottom-dock"')
    expect(html).toContain('aria-label="Navegación principal"')
    expect(html).toContain('data-tooltip="Inicio"')
    expect(html).toContain('data-tooltip="Documentos"')
    expect(html).toContain('data-tooltip="Análisis IA"')
    expect(html).toContain('data-tooltip="Comparar versiones"')
    expect(html).toContain('data-tooltip="Reportes Turniting"')
    expect(html).toContain('data-tooltip="Modelos"')
    expect(html).toContain('data-tooltip="Datasets"')
  })

  it('marks the active dock item for /documents and /documents/:id (Análisis IA) and updates breadcrumbs', () => {
    const docsHtml = renderLayout('/documents')
    expect(docsHtml).toContain('aria-label="Documentos" data-tooltip="Documentos" aria-current="page" class="dock-item is-active" href="/documents"')
    expect(docsHtml).toContain('breadcrumb-current" aria-current="page">Documentos<')

    const analysisHtml = renderLayout('/documents/79e92350-c705-486d-bc56-8d431e41bf7a')
    expect(analysisHtml).toContain('class="dock-item is-active" aria-label="Análisis IA"')
    expect(analysisHtml).toContain('TESIS_EC_sin_Turnitin.docx')
  })
})
