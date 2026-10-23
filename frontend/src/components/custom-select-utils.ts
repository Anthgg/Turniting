export type CustomSelectOption = {
  value: string
  label: string
  disabled?: boolean
}

export function nextEnabledOptionIndex(
  options: CustomSelectOption[],
  startIndex: number,
  step: 1 | -1,
) {
  if (options.length === 0) return -1
  let index = startIndex
  for (let attempts = 0; attempts < options.length; attempts += 1) {
    index = (index + step + options.length) % options.length
    if (!options[index].disabled) return index
  }
  return -1
}

export function findEnabledOptionByPrefix(
  options: CustomSelectOption[],
  prefix: string,
  startIndex: number,
) {
  const query = prefix.trim().toLocaleLowerCase()
  if (!query || options.length === 0) return -1

  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = (startIndex + offset + options.length) % options.length
    const option = options[index]
    if (!option.disabled && option.label.toLocaleLowerCase().startsWith(query)) return index
  }

  return -1
}
