import {
  analyzeQuickText,
  type AnalysisClassification,
  type QuickAnalysisResponse,
} from '../../api/analysis'
import { ApiRequestError } from '../../api/client'

export const MAX_TEXT_LENGTH = 20_000

const BLANK_LINE = /\n[ \t\r\f\v]*\n/gu
const SENTENCE_END = /[.!?:;»")\]]\s*$/u
const LIST_ITEM = /^\s*(?:[-•*·▪]|\d{1,3}[.)]|[a-zA-Z][.)])\s+/u

export function getQuickAnalysisErrorMessage(error: unknown) {
  if (error instanceof ApiRequestError) {
    if (error.status === 413 || error.code === 'TEXT_TOO_LONG') {
      return 'El servicio rechazó el texto porque supera el límite de 20 000 caracteres. Reduce el texto e inténtalo de nuevo.'
    }
    if (error.status === 503) {
      return 'El servicio de análisis no está disponible en este momento. Inténtalo de nuevo más tarde.'
    }
    if (error.status >= 500) {
      return 'El análisis no pudo completarse por un problema del servicio. Inténtalo de nuevo más tarde.'
    }
    return error.message
  }
  return 'No se pudo conectar con el servicio de análisis. Revisa la conexión e inténtalo de nuevo.'
}

export function isQuickAnalysisRetryable(error: unknown) {
  if (!(error instanceof ApiRequestError)) return true
  return error.status === 408 || error.status === 429 || error.status >= 500
}

export function isQuickAnalysisShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean }) {
  return (event.ctrlKey || event.metaKey) && event.key === 'Enter'
}

export function getQuickAnalysisOverLimitGuidance(textLength: number) {
  const excess = Math.max(0, textLength - MAX_TEXT_LENGTH)
  if (excess === 0) return null
  return `El máximo es ${MAX_TEXT_LENGTH.toLocaleString('es-PE')} caracteres. Elimina ${excess.toLocaleString('es-PE')} ${excess === 1 ? 'carácter' : 'caracteres'} para continuar.`
}

function codePointLength(value: string) {
  return Array.from(value).length
}

function splitWrappedLines(text: string, start: number, end: number): Array<[number, number]> {
  const block = text.slice(start, end)
  let cursor = start
  const lines = block.split('\n').map((line) => {
    const lineStart = cursor
    const lineEnd = lineStart + line.length
    cursor = lineEnd + 1
    return { start: lineStart, end: lineEnd, text: line, length: codePointLength(line) }
  }).filter((line) => line.text.trim().length > 0)

  if (lines.length <= 1) return lines.map((line) => [line.start, line.end])

  const lengths = lines.map((line) => line.length).sort((a, b) => a - b)
  const typical = lengths[Math.floor(lengths.length * 0.75)]
  const ends = lines.filter((line) => SENTENCE_END.test(line.text.trimEnd()) || line.length < 40).length
  const lineParagraphs = ends / lines.length > 0.6
  const spans: Array<[number, number]> = []
  let current = [lines[0]]

  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1]
    const line = lines[index]
    const previousText = previous.text.trimEnd()
    const nextText = line.text.trimStart()
    const shortPrevious = previous.length < 0.75 * typical
    const firstNextCharacter = Array.from(nextText)[0]
    const isUpperCase = Boolean(
      firstNextCharacter
      && firstNextCharacter.toLowerCase() !== firstNextCharacter.toUpperCase()
      && firstNextCharacter === firstNextCharacter.toUpperCase(),
    )
    let breaks = (SENTENCE_END.test(previousText) && (shortPrevious || isUpperCase))
      || LIST_ITEM.test(nextText)

    if (lineParagraphs) breaks = true
    if (breaks) {
      spans.push([current[0].start, current[current.length - 1].end])
      current = [line]
    } else {
      current.push(line)
    }
  }

  spans.push([current[0].start, current[current.length - 1].end])
  return spans
}

/** Mirrors the analyzer's paragraph boundaries so source text stays in the browser. */
export function splitQuickTextParagraphs(text: string) {
  const blocks: Array<[number, number]> = []
  let position = 0

  for (const match of text.matchAll(BLANK_LINE)) {
    const boundary = match.index ?? position
    blocks.push([position, boundary])
    position = boundary + match[0].length
  }
  blocks.push([position, text.length])

  const spans: Array<[number, number]> = []
  for (const [start, end] of blocks) {
    const block = text.slice(start, end)
    if (!block.trim()) continue

    const withoutOuterNewlines = block.replace(/^\n+|\n+$/gu, '')
    if (withoutOuterNewlines.includes('\n')) spans.push(...splitWrappedLines(text, start, end))
    else spans.push([start, end])
  }

  return spans.map(([start, end]) => text.slice(start, end).trim()).filter(Boolean)
}

export type QuickResultFilter = 'all' | 'review' | 'flagged' | 'unevaluated'

export function filterQuickResultParagraphs(
  paragraphs: QuickAnalysisResponse['paragraphs'],
  filter: QuickResultFilter,
) {
  if (filter === 'review') return paragraphs.filter((paragraph) => paragraph.reviewHighlighted)
  if (filter === 'flagged') return paragraphs.filter((paragraph) => paragraph.scientificFlag === true)
  if (filter === 'unevaluated') {
    return paragraphs.filter((paragraph) => paragraph.status === 'INSUFFICIENT_TEXT' || paragraph.score === null)
  }
  return paragraphs
}

function copyPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return 'No evaluado'
  return `${(Math.round(value * 1000) / 10).toLocaleString('es-PE', { maximumFractionDigits: 1 })}%`
}

function copyParagraphLine(paragraph: QuickAnalysisResponse['paragraphs'][number], text: string | undefined) {
  const score = paragraph.status === 'INSUFFICIENT_TEXT' || paragraph.score === null
    ? 'No evaluado'
    : copyPercent(paragraph.score)
  return [`Párrafo ${paragraph.index + 1} — ${score}`, text ?? 'Texto no disponible'].join('\n')
}

export function formatQuickParagraphCopy(
  paragraph: QuickAnalysisResponse['paragraphs'][number],
  paragraphText: string | undefined,
) {
  return copyParagraphLine(paragraph, paragraphText)
}

export type QuickResultCopySettings = {
  analyzer: string
  profile: string
  mode: string
  language: string
}

export function formatQuickResultCopy(
  result: QuickAnalysisResponse,
  paragraphTexts: string[],
  settings?: QuickResultCopySettings,
) {
  const overallScore = result.evaluated && result.score !== null ? copyPercent(result.score) : 'No evaluado'
  const paragraphs = result.paragraphs.map((paragraph) =>
    copyParagraphLine(paragraph, paragraphTexts[paragraph.index]),
  )
  return [
    'TURNITING — Análisis rápido',
    `Señal global estimada: ${overallScore}`,
    `Párrafos evaluados: ${result.scoredParagraphs} de ${result.paragraphs.length}`,
    ...paragraphs,
    `Analizador: ${settings?.analyzer ?? result.analyzer ?? 'No indicado'}`,
    `Perfil: ${settings?.profile ?? result.thresholdProfile ?? 'No indicado'}`,
    `Modo: ${settings?.mode ?? result.paragraphMode ?? 'No indicado'}`,
    `Idioma: ${settings?.language ?? result.languageCode.toUpperCase()}`,
  ].join('\n\n')
}

function copyWithExecCommand(value: string) {
  if (typeof document === 'undefined' || !document.body) return false
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('aria-hidden', 'true')
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } finally {
    document.body.removeChild(textarea)
  }
  return copied
}

export async function copyPlainText(
  value: string,
  clipboardWrite: ((text: string) => Promise<void>) | undefined = typeof navigator !== 'undefined' && navigator.clipboard
    ? navigator.clipboard.writeText.bind(navigator.clipboard)
    : undefined,
  fallbackCopy: (text: string) => boolean = copyWithExecCommand,
) {
  try {
    if (!clipboardWrite) throw new Error('Clipboard API is unavailable')
    await clipboardWrite(value)
    return 'clipboard' as const
  } catch {
    if (fallbackCopy(value)) return 'fallback' as const
    throw new Error('No se pudo copiar el resultado. Revisa los permisos del navegador.')
  }
}

export function isQuickResultStale(currentText: string, analyzedTextSnapshot: string) {
  return currentText !== analyzedTextSnapshot
}

export async function runQuickAnalysis(
  text: string,
  request: (input: string) => Promise<QuickAnalysisResponse> = analyzeQuickText,
) {
  try {
    return { result: await request(text), error: null, retryable: false }
  } catch (error) {
    return {
      result: null,
      error: getQuickAnalysisErrorMessage(error),
      retryable: isQuickAnalysisRetryable(error),
    }
  }
}

export type { AnalysisClassification }
