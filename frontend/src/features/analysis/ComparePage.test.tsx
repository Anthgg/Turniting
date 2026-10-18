import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ContextualComparisonNotice } from './ComparePage'

describe('contextual version comparison notice', () => {
  it('stays hidden when both selected runs are strict', () => {
    const html = renderToStaticMarkup(createElement(ContextualComparisonNotice, {
      paragraphModes: ['STRICT_PARAGRAPH', 'STRICT_PARAGRAPH'],
    }))

    expect(html).toBe('')
  })

  it('warns that contextual changes can affect neighboring paragraph signals', () => {
    const html = renderToStaticMarkup(createElement(ContextualComparisonNotice, {
      paragraphModes: ['STRICT_PARAGRAPH', 'CONTEXTUAL_PARAGRAPH'],
    }))

    expect(html).toContain('modificar un párrafo puede cambiar también la señal de párrafos vecinos')
    expect(html).toContain('contexto de inferencia')
  })
})
