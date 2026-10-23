import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CustomSelect } from './CustomSelect'
import { findEnabledOptionByPrefix, nextEnabledOptionIndex, type CustomSelectOption } from './custom-select-utils'

const options: CustomSelectOption[] = [
  { value: 'alpha', label: 'Alfa' },
  { value: 'beta', label: 'Beta', disabled: true },
  { value: 'gamma', label: 'Gamma' },
]

describe('CustomSelect', () => {
  it('renders a labeled select-only combobox instead of a native select', () => {
    const markup = renderToStaticMarkup(
      <CustomSelect
        id="quick-profile"
        label="Perfil"
        value="alpha"
        options={options}
        onChange={() => undefined}
      />,
    )

    expect(markup).toContain('role="combobox"')
    expect(markup).toContain('aria-label="Perfil: Alfa"')
    expect(markup).toContain('aria-haspopup="listbox"')
    expect(markup).toContain('Alfa')
    expect(markup).not.toContain('<select')
  })

  it('moves through enabled options and wraps without landing on disabled options', () => {
    expect(nextEnabledOptionIndex(options, 0, 1)).toBe(2)
    expect(nextEnabledOptionIndex(options, 2, 1)).toBe(0)
    expect(nextEnabledOptionIndex(options, 0, -1)).toBe(2)
    expect(nextEnabledOptionIndex([{ value: 'x', label: 'X', disabled: true }], -1, 1)).toBe(-1)
  })

  it('supports typeahead while skipping disabled options', () => {
    expect(findEnabledOptionByPrefix(options, 'ga', 0)).toBe(2)
    expect(findEnabledOptionByPrefix(options, 'be', 0)).toBe(-1)
    expect(findEnabledOptionByPrefix(options, '', 0)).toBe(-1)
  })
})
