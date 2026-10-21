import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  codePointOffsetToUtf16,
  convertPythonSpansToUtf16,
  createReviewDocumentContext,
  detectReferenceSectionStart,
  findReferenceSectionStart,
  getReviewEvidence,
  getReviewPresentation,
  getReviewStructuralType,
  isAnnexSectionHeading,
  isReferenceHeading,
  mergeReviewSpansForDisplay,
  normalizeReviewSegmentOffsets,
  ReportReviewIntegrityError,
  validateReportReviewEvidenceSpans,
  type ReviewSegment,
} from './review-presentation.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

function segment(text: string, score: number | null, options: Partial<ReviewSegment> = {}): ReviewSegment {
  return {
    paragraphIndex: 0,
    textHash: hash(text),
    charStart: 0,
    charEnd: text.length,
    signalLevel: 'HIGH',
    classification: 'MACHINE_SIGNAL',
    calibratedScore: score,
    ...options,
  };
}

describe('threshold review evidence', () => {
  it.each([
    [0.589999, false],
    [0.59, true],
    [0.590001, true],
  ])('uses the inclusive persisted threshold boundary for score %s', (score, flagged) => {
    const text = 'Synthetic paragraph evaluated for review.';
    const item = segment(text, score);
    const context = createReviewDocumentContext(text, [item]);
    const evidence = getReviewEvidence(item, 0.59, context);
    expect(evidence).toMatchObject({ evaluated: true, flagged, threshold: 0.59 });
    expect(getReviewPresentation(item, context, 0.59).highlight).toBe(true);
  });

  it('uses a non-default run threshold without introducing a score band', () => {
    const text = 'Another synthetic paragraph evaluated for review.';
    const item = segment(text, 0.6442953);
    const context = createReviewDocumentContext(text, [item]);
    expect(getReviewEvidence(item, 0.6442953, context).flagged).toBe(true);
    expect(getReviewEvidence(segment(text, 0.6442952), 0.6442953, context).flagged).toBe(false);
  });

  it('keeps scored metadata and references evaluable while excluding them from presentation', () => {
    const texts = ['Autor: Ana Ejemplo', 'Referencias', 'Smith (2024). Synthetic reference.'];
    const fullText = texts.join('\n\n');
    let cursor = 0;
    const segments = texts.map((text, paragraphIndex) => {
      const item = segment(text, 0.95, {
        paragraphIndex,
        charStart: cursor,
        charEnd: cursor + text.length,
        textHash: hash(text),
      });
      cursor += text.length + 2;
      return item;
    });
    const context = createReviewDocumentContext(fullText, segments);
    const metadata = getReviewEvidence(segments[0]!, 0.59, context);
    const reference = getReviewEvidence(segments[2]!, 0.59, context);
    expect(metadata).toMatchObject({ evaluated: true, flagged: true, presentationExcluded: true, excludedReason: 'METADATA' });
    expect(reference).toMatchObject({ evaluated: true, flagged: true, presentationExcluded: true, excludedReason: 'REFERENCE_SECTION' });
    expect(getReviewPresentation(segments[0]!, context, 0.59).highlight).toBe(false);
    expect(getReviewPresentation(segments[2]!, context, 0.59).highlight).toBe(false);
  });

  it('prepares paragraph-relative span evidence and merges visual overlaps without mutation', () => {
    const text = 'ABCDEFGHIJKLMN';
    const spans = [
      { startChar: 2, endChar: 5 },
      { startChar: 8, endChar: 11 },
    ];
    validateReportReviewEvidenceSpans(text, spans);
    expect(spans.map(({ startChar, endChar }) => text.slice(startChar, endChar))).toEqual(['CDE', 'IJK']);
    const overlapping = [{ startChar: 2, endChar: 6 }, { startChar: 5, endChar: 10 }];
    expect(mergeReviewSpansForDisplay(overlapping)).toEqual([{ startChar: 2, endChar: 10 }]);
    expect(overlapping).toEqual([{ startChar: 2, endChar: 6 }, { startChar: 5, endChar: 10 }]);
  });

  it('maps Python codepoint offsets to UTF-16 and rejects split surrogate pairs', () => {
    const text = 'Autenticación 😀 biométrica';
    const pythonOffset = Array.from(text).indexOf('b');
    const utf16Offset = codePointOffsetToUtf16(text, pythonOffset);
    expect(utf16Offset).toBe(text.indexOf('biométrica'));
    expect(text.slice(utf16Offset)).toBe('biométrica');
    const converted = convertPythonSpansToUtf16(text, [{
      startCodePoint: pythonOffset,
      endCodePoint: Array.from(text).length,
    }]);
    expect(text.slice(converted[0]!.startChar, converted[0]!.endChar)).toBe('biométrica');
    const emoji = text.indexOf('😀');
    expect(() => validateReportReviewEvidenceSpans(text, [{ startChar: emoji + 1, endChar: text.length }]))
      .toThrowError(ReportReviewIntegrityError);
  });

  it('normalizes legacy paragraph offsets and Python whitespace-normalized hashes', () => {
    const prefix = 'Título 😀\n\n';
    const paragraph = 'La primera línea describe un caso ficticio.\n   La segunda línea explica cómo revisar la evidencia.';
    const text = `${prefix}${paragraph}`;
    const item = segment(paragraph, 0.8, {
      paragraphIndex: 1,
      charStart: Array.from(prefix).length,
      charEnd: Array.from(text).length,
      textHash: hash(paragraph.replace(/\s+/gu, ' ').trim()),
    });

    const normalized = normalizeReviewSegmentOffsets(text, [item]);
    const context = createReviewDocumentContext(text, normalized);

    expect(normalized[0]?.charStart).toBe(prefix.length);
    expect(normalized[0]?.charEnd).toBe(text.length);
    expect(context.byParagraphIndex.get(1)?.text).toBe(paragraph);
  });

  it('normalizes Python span offsets at the backend evidence boundary', () => {
    const text = 'Autenticación 😀 biométrica';
    const startCodePoint = Array.from(text).findIndex((character) => character === 'b');
    const endCodePoint = Array.from(text).length;
    const item = segment(text, 0.8, {
      evidence: { granularity: 'SPAN', spans: [{ startCodePoint, endCodePoint }] },
    });
    const context = createReviewDocumentContext(text, [item]);
    const spans = getReviewEvidence(item, 0.59, context).spans;
    expect(text.slice(spans[0]!.startChar, spans[0]!.endChar)).toBe('biométrica');
  });

  it('rejects unsafe, non-finite, out-of-bounds, and surrogate-splitting ranges', () => {
    const text = 'ABCDEFGHIJKLMN';
    for (const span of [
      { startChar: Number.NaN, endChar: 2 },
      { startChar: Number.MAX_SAFE_INTEGER + 1, endChar: Number.MAX_SAFE_INTEGER + 2 },
      { startChar: -1, endChar: 2 },
      { startChar: 2, endChar: text.length + 1 },
    ]) {
      expect(() => validateReportReviewEvidenceSpans(text, [span])).toThrowError(ReportReviewIntegrityError);
    }
  });

  it('uses whole-paragraph fallback when future span evidence is unavailable', () => {
    const text = 'Synthetic span-ready paragraph.';
    const item = segment(text, 0.8, { evidence: { granularity: 'SPAN', spans: [] } });
    const context = createReviewDocumentContext(text, [item]);
    expect(getReviewEvidence(item, 0.59, context)).toMatchObject({
      granularity: 'SPAN',
      paragraphFlagged: true,
      spans: [],
      fallbackReason: 'SPAN_EVIDENCE_UNAVAILABLE',
    });
    expect(getReviewPresentation(item, context, 0.59).highlight).toBe(true);
  });
});

function documentFixture(
  texts: readonly string[],
  options: readonly Partial<ReviewSegment>[] = [],
) {
  let cursor = 0;
  const segments = texts.map((text, paragraphIndex) => {
    const item = segment(text, 0.8, {
      paragraphIndex,
      charStart: cursor,
      charEnd: cursor + text.length,
      textHash: hash(text.replace(/\s+/gu, ' ').trim()),
      ...options[paragraphIndex],
    });
    cursor += text.length + 2;
    return item;
  });
  const text = texts.join('\n\n');
  return { text, segments, context: createReviewDocumentContext(text, segments) };
}

describe('reference section presentation state', () => {
  it.each([
    'Referencias',
    'Referencias:',
    'Referencias bibliográficas',
    'Referencias bibliográficas:',
    'Bibliografía',
    'Bibliografía:',
    'References',
    'References:',
    'Bibliography',
    'Bibliography:',
    'REFERENCIAS BIBLIOGRÁFICAS',
    'Fuentes bibliográficas',
    'Literatura citada',
    'Works cited',
  ])('recognizes the explicit heading %s', (text) => {
    expect(detectReferenceSectionStart(text)).toMatchObject({
      inline: false,
      numbered: false,
      rule: 'EXACT_HEADING',
    });
    expect(isReferenceHeading(text)).toBe(true);
  });

  it.each([
    ['References: Smith et al. (2025). Synthetic bibliography.', 'references'],
    ['Referencias: Pérez et al. (2024). Fuente sintética.', 'referencias'],
    ['Bibliografía: García (2023). Fuente sintética.', 'bibliografía'],
    ['  BIBLIOGRAFI\u0301A：\tGarcía et al.  ', 'bibliografía'],
    ['  REFERENCIAS \n BIBLIOGRÁFICAS: Pérez (2025). ', 'referencias bibliográficas'],
  ])('recognizes normalized inline heading syntax in %s', (text, heading) => {
    expect(detectReferenceSectionStart(text)).toEqual({
      heading,
      inline: true,
      numbered: false,
      rule: 'INLINE_COLON',
    });
  });

  it.each([
    '5. Referencias',
    'VI. Referencias',
    '6 REFERENCIAS',
    '5.2. Referencias bibliográficas:',
    'IV) Bibliography',
  ])('recognizes the clearly numbered heading %s', (text) => {
    expect(detectReferenceSectionStart(text)).toMatchObject({
      inline: false,
      numbered: true,
      rule: 'NUMBERED_HEADING',
    });
  });

  it('records numbering and inline syntax without retaining bibliographic contents', () => {
    expect(detectReferenceSectionStart('VI. References: Smith, private-looking test entry.'))
      .toEqual({ heading: 'references', inline: true, numbered: true, rule: 'INLINE_COLON' });
  });

  it.each([
    'Las referencias utilizadas en esta investigación fueron seleccionadas cuidadosamente.',
    'Estas referencias permiten explicar los resultados obtenidos.',
    'La bibliografía analizada demuestra una mejora en el método.',
    'Las referencias [1] y [2] muestran resultados consistentes.',
    'Este marco se apoya en referencias recientes.',
    'References are discussed in the next section.',
    'References to prior work: they support the method.',
    'Referencias utilizadas para validar el procedimiento.',
    'Bibliografía analizada demuestra resultados favorables.',
    '5. Referencias utilizadas en esta investigación.',
    'Referencias .............. 40',
    '“References: Smith et al.” es una cita de ejemplo.',
    'VIIII. Referencias',
  ])('keeps normal prose/contents entries outside references: %s', (text) => {
    expect(detectReferenceSectionStart(text)).toBeNull();
    const fixture = documentFixture([text]);
    expect(fixture.context.referenceSectionStart).toBeNull();
    expect(getReviewEvidence(fixture.segments[0]!, 0.59, fixture.context).excludedReason)
      .not.toBe('REFERENCE_SECTION');
  });

  it('uses explicit heading metadata for a separate heading line without guessing from body prose', () => {
    const text = 'References\nSmith et al. (2025). Synthetic citation.';
    expect(detectReferenceSectionStart(text)).toBeNull();
    expect(detectReferenceSectionStart(text, { headingLike: true }))
      .toMatchObject({ heading: 'references', rule: 'HEADING_LINE', inline: true });
    const fixture = documentFixture([text], [{ structuralType: 'HEADING' }]);
    expect(getReviewEvidence(fixture.segments[0]!, 0.59, fixture.context).excludedReason)
      .toBe('REFERENCE_SECTION');
  });

  it('retains six raw flagged scores while two reference exclusions leave four actionable highlights', () => {
    const fixture = documentFixture([
      'El primer párrafo sintético describe resultados verificables del procedimiento.',
      'El segundo párrafo sintético explica la metodología utilizada en la evaluación.',
      'El tercer párrafo sintético presenta observaciones suficientes sobre el método.',
      'El cuarto párrafo sintético analiza las conclusiones del caso de prueba.',
      'References: Smith et al. (2025). Synthetic reference heading and first entry.',
      'García (2024). Another synthetic bibliographic entry.',
    ], [
      { calibratedScore: 0.8 }, { calibratedScore: 0.61 },
      { calibratedScore: 0.9 }, { calibratedScore: 0.59 },
      { calibratedScore: 0.91 }, { calibratedScore: 0.83 },
    ]);
    const before = structuredClone(fixture.segments);
    const evidence = fixture.segments.map((item) => getReviewEvidence(item, 0.59, fixture.context));
    expect(evidence.filter((item) => item.evaluated)).toHaveLength(6);
    expect(evidence.filter((item) => item.flagged)).toHaveLength(6);
    expect(evidence.filter((item) => item.flagged && item.presentationExcluded)).toHaveLength(2);
    expect(evidence.filter((item) => item.flagged && !item.presentationExcluded)).toHaveLength(4);
    expect(evidence.map((item) => item.score)).toEqual([0.8, 0.61, 0.9, 0.59, 0.91, 0.83]);
    expect(evidence.map((item) => item.threshold)).toEqual(Array(6).fill(0.59));
    expect(fixture.segments).toEqual(before);
    expect(fixture.context.referenceSectionStartSegment).toBe(4);
    expect(fixture.context.referenceSectionStart).toBe(fixture.segments[4]!.charStart);
    expect(findReferenceSectionStart(fixture.context.segments)).toBe(fixture.segments[4]!.charStart);
    expect(fixture.context.referenceSections).toEqual([{
      heading: 'references', rule: 'INLINE_COLON', inline: true, numbered: false,
      startOffset: fixture.segments[4]!.charStart, endOffset: fixture.text.length,
      startSegment: 4, endSegmentExclusive: 6,
    }]);
  });

  it('keeps the reference state through prose mentions of annexes, then exits only at an explicit annex heading', () => {
    const fixture = documentFixture([
      'References: Smith et al. (2025). Synthetic citation.',
      'Los anexos contienen material adicional y se describen en una referencia.',
      'ANEXOS',
      'El anexo explica resultados adicionales mediante prosa sintética evaluada.',
    ]);
    expect(fixture.context.referenceSections[0]).toMatchObject({
      startSegment: 0, endSegmentExclusive: 2, endOffset: fixture.segments[2]!.charStart,
    });
    expect(fixture.context.annexSectionStartSegment).toBe(2);
    expect(fixture.context.annexSectionStart).toBe(fixture.segments[2]!.charStart);
    expect(getReviewStructuralType(fixture.segments[1]!, fixture.context)).toBe('REFERENCE_SECTION');
    expect(getReviewStructuralType(fixture.segments[2]!, fixture.context)).toBe('HEADING');
    expect(getReviewStructuralType(fixture.segments[3]!, fixture.context)).toBe('ANNEX_SECTION');
    expect(getReviewEvidence(fixture.segments[2]!, 0.59, fixture.context)).toMatchObject({
      evaluated: true, flagged: true, presentationExcluded: true, excludedReason: 'HEADING',
    });
    expect(getReviewEvidence(fixture.segments[3]!, 0.59, fixture.context)).toMatchObject({
      evaluated: true, flagged: true, presentationExcluded: false,
    });
  });

  it.each(['ANEXOS', 'ANEXO', 'APPENDIX', 'APPENDICES', 'Apéndices', '7. Anexos', 'Anexo A: Instrumento', 'Appendix II'])
  ('recognizes the explicit annex transition %s', (text) => {
    expect(isAnnexSectionHeading(text)).toBe(true);
  });

  it.each([
    'Los anexos presentan resultados complementarios.',
    'Anexos utilizados para la validación.',
    'Anexos permiten revisar los datos.',
    'Appendix supplementary material',
    'Anexo CIVIL',
  ])('does not end references on ordinary appendix prose: %s', (text) => {
    expect(isAnnexSectionHeading(text)).toBe(false);
  });

  it('uses persisted structural hints for grouping without changing table scores or body actionability', () => {
    const fixture = documentFixture([
      'Celda sintética con contenido evaluado y trazable.',
      'La prosa de cuerpo conserva exactamente su predicción persistida.',
    ], [{ structuralType: 'TABLE_CELL', calibratedScore: 0.83241 }, { calibratedScore: 0.59 }]);
    expect(getReviewStructuralType(fixture.segments[0]!, fixture.context)).toBe('TABLE_CELL');
    expect(getReviewStructuralType(fixture.segments[1]!, fixture.context)).toBe('BODY');
    expect(getReviewEvidence(fixture.segments[0]!, 0.59, fixture.context)).toMatchObject({
      evaluated: true, flagged: true, score: 0.83241, threshold: 0.59,
    });
    expect(getReviewPresentation(fixture.segments[1]!, fixture.context, 0.59).highlight).toBe(true);
  });
});
