import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { Icon } from './Icon'
import { findEnabledOptionByPrefix, nextEnabledOptionIndex, type CustomSelectOption } from './custom-select-utils'
import './CustomSelect.css'

export function CustomSelect({
  id,
  label,
  value,
  options,
  onChange,
  disabled = false,
  className = '',
}: {
  id: string
  label: string
  value: string
  options: CustomSelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLDivElement | null>>([])
  const typeaheadRef = useRef('')
  const typeaheadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const listboxId = `${id}-listbox`
  const selectedIndex = options.findIndex((option) => option.value === value)
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined

  function selectedEnabledIndex() {
    return selectedIndex >= 0 && !options[selectedIndex].disabled
      ? selectedIndex
      : nextEnabledOptionIndex(options, -1, 1)
  }

  function openMenu(index = selectedEnabledIndex()) {
    setActiveIndex(index)
    setOpen(true)
  }

  function chooseOption(index: number) {
    const option = options[index]
    if (!option || option.disabled) return
    onChange(option.value)
    setOpen(false)
    setActiveIndex(index)
    triggerRef.current?.focus()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      if (!open) {
        const currentIndex = selectedIndex >= 0 ? selectedIndex : step === 1 ? -1 : 0
        openMenu(nextEnabledOptionIndex(options, currentIndex, step))
        return
      }
      setActiveIndex((current) => nextEnabledOptionIndex(options, current, step))
      return
    }

    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const start = event.key === 'Home' ? -1 : 0
      const step = event.key === 'Home' ? 1 : -1
      openMenu(nextEnabledOptionIndex(options, start, step))
      return
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (open) chooseOption(activeIndex)
      else openMenu()
      return
    }

    if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
      setActiveIndex(selectedIndex)
      return
    }

    if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      const nextQuery = `${typeaheadRef.current}${event.key}`
      typeaheadRef.current = nextQuery
      if (typeaheadTimerRef.current) window.clearTimeout(typeaheadTimerRef.current)
      typeaheadTimerRef.current = window.setTimeout(() => {
        typeaheadRef.current = ''
        typeaheadTimerRef.current = null
      }, 700)

      const start = open ? activeIndex : selectedIndex
      let matchingIndex = findEnabledOptionByPrefix(options, nextQuery, start)
      if (matchingIndex < 0 && nextQuery.length > 1) {
        matchingIndex = findEnabledOptionByPrefix(options, event.key, start)
      }
      if (matchingIndex >= 0) {
        setActiveIndex(matchingIndex)
        setOpen(true)
      }
    }
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (event.relatedTarget && rootRef.current?.contains(event.relatedTarget as Node)) return
    setOpen(false)
  }

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [open])

  useEffect(() => {
    if (!open || activeIndex < 0) return
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, open])

  useEffect(() => () => {
    if (typeaheadTimerRef.current) window.clearTimeout(typeaheadTimerRef.current)
  }, [])

  return (
    <div ref={rootRef} className={`custom-select${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''} ${className}`.trim()} onBlur={handleBlur}>
      <button
        ref={triggerRef}
        id={id}
        className="custom-select-trigger"
        type="button"
        role="combobox"
        aria-label={`${label}: ${selectedOption?.label ?? 'Selecciona una opción'}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
        disabled={disabled}
        onClick={() => open ? setOpen(false) : openMenu()}
        onKeyDown={handleKeyDown}
      >
        <span className="custom-select-value">{selectedOption?.label ?? 'Selecciona una opción'}</span>
        <Icon name="chevron-down" size={15} />
      </button>

      {open && (
        <div id={listboxId} className="custom-select-listbox" role="listbox" aria-label={label}>
          {options.map((option, index) => (
            <div
              ref={(node) => { optionRefs.current[index] = node }}
              id={`${listboxId}-option-${index}`}
              className={`custom-select-option${index === activeIndex ? ' is-active' : ''}${option.value === value ? ' is-selected' : ''}${option.disabled ? ' is-option-disabled' : ''}`}
              key={`${option.value}-${index}`}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => { if (!option.disabled) setActiveIndex(index) }}
              onClick={() => chooseOption(index)}
            >
              <span>{option.label}</span>
              {option.value === value && <Icon name="check" size={15} />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
