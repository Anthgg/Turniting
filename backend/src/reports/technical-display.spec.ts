import { describe, expect, it } from 'vitest';
import type { AIReportParagraph } from './report.contracts.js';
import { buildTechnicalDisplayUnits } from './technical-display.js';
import { presentationStructureHint } from '../analysis/presentation-structure.js';

function fixture(entries: Array<Partial<AIReportParagraph> & { textPreview: string }>, gaps?: string[]) {
  let extractedText = '';
  const paragraphs = entries.map((entry, paragraphIndex): AIReportParagraph => {
    if (paragraphIndex) extractedText += gaps?.[paragraphIndex - 1] ?? '\n';
    const charStart = extractedText.length;
    extractedText += entry.textPreview;
    const score = entry.score ?? null;
    return { paragraphIndex, textHash: 'synthetic', charStart, charEnd: extractedText.length, score,
      classification: score === null ? 'INSUFFICIENT_TEXT' : 'MACHINE_SIGNAL', signalLevel: null,
      pageNumber: 1, words: null, tokens: null,
      segmentEvidence: { type: 'PARAGRAPH', paragraphId: paragraphIndex, start: charStart, end: extractedText.length, score, level: null },
      reviewPresentation: { highlight: score !== null && score >= .59, level: null }, ...entry };
  });
  return { paragraphs, options: { extractedText, threshold: .59 } };
}

describe('F009.4.2 technical display transform', () => {
  it('groups 20 table cells once, with complete source IDs and no block score', () => {
    const input = fixture(Array.from({ length: 20 }, (_, index) => ({ textPreview: `Cell ${index}`, structuralType: 'TABLE_CELL', structuralGroupId: 'table-1' })));
    const output = buildTechnicalDisplayUnits(input.paragraphs, input.options);
    expect(output.units).toHaveLength(1);
    expect(output.units[0]).toMatchObject({ type: 'TABLE_GROUP', sourceSegmentIds: Array.from({ length: 20 }, (_, index) => index) });
    expect(output.units[0]).not.toHaveProperty('score');
    expect(output.audit).toMatchObject({ sourceSegmentsRepresented: 20, sourceSegmentsLost: 0, sourceSegmentsDuplicated: 0 });
  });

  it('retains two evaluated table member scores exactly without aggregating', () => {
    const input = fixture(Array.from({ length: 10 }, (_, index) => ({ textPreview: `Cell ${index}`, kind: 'TABLE_CELL',
      score: index === 3 ? .63241 : index === 6 ? .43219 : null,
      presentationExcluded: index !== 3 && index !== 6,
      excludedReason: index === 3 || index === 6 ? null : 'INSUFFICIENT_TEXT' })));
    const before = JSON.stringify(input);
    const output = buildTechnicalDisplayUnits(input.paragraphs, input.options);
    expect(output.units).toHaveLength(1);
    expect(output.units[0]!.sourceSegments.filter(segment => segment.score !== null).map(segment => segment.score)).toEqual([.63241, .43219]);
    expect(output.counts).toMatchObject({ evaluated: 2, rawFlaggedCount: 1, evaluatedDisplayUnits: 2 });
    expect(output.units[0]).not.toHaveProperty('score');
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(['METADATA', 'REFERENCE_SECTION', 'CAPTION', 'HEADING'])('groups compatible consecutive %s members', reason => {
    const input = fixture(['one', 'two', 'three'].map(textPreview => ({ textPreview, presentationExcluded: true, excludedReason: reason })));
    const output = buildTechnicalDisplayUnits(input.paragraphs, input.options);
    expect(output.units).toHaveLength(1);
    expect(output.units[0]!.sourceSegmentIds).toEqual([0, 1, 2]);
  });

  it('joins only compatible contiguous insufficient body text and never across an evaluated body', () => {
    const input = fixture([{ textPreview: 'Este estudio' }, { textPreview: 'analiza autenticación' }, { textPreview: 'continua.' },
      { textPreview: 'Evaluated body', score: .83241 }, { textPreview: 'Final item' }], [' ', ' ', '\n', '\n']);
    const output = buildTechnicalDisplayUnits(input.paragraphs, input.options);
    expect(output.units.map(unit => unit.type)).toEqual(['STRUCTURAL_GROUP', 'EVALUATED_SEGMENT', 'INSUFFICIENT_SEGMENT']);
    expect(output.units[0]!.text).toBe('Este estudio analiza autenticación continua.');
    expect(output.units[0]!.sourceSegmentIds).toEqual([0, 1, 2]);
    expect(output.units[1]!.sourceSegments[0]!.score).toBe(.83241);
  });

  it('does not join across omitted non-whitespace, large offset gaps, pages, or different table IDs', () => {
    for (const gap of [' omitted content ', ' '.repeat(33)]) {
      const input = fixture([{ textPreview: 'first' }, { textPreview: 'second' }], [gap]);
      expect(buildTechnicalDisplayUnits(input.paragraphs, input.options).units).toHaveLength(2);
    }
    const input = fixture([{ textPreview: 'first', pageNumber: 1 }, { textPreview: 'second', pageNumber: 2 }]);
    expect(buildTechnicalDisplayUnits(input.paragraphs, input.options).units).toHaveLength(2);
    const tables = fixture([{ textPreview: 'first', kind: 'TABLE_CELL', structuralGroupId: 'a' }, { textPreview: 'second', kind: 'TABLE_CELL', structuralGroupId: 'b' }]);
    expect(buildTechnicalDisplayUnits(tables.paragraphs, tables.options).units).toHaveLength(2);
  });

  it('distinguishes six detector flags from four actionable highlights, preserving every exact value', () => {
    const input = fixture([
      ...[.80, .20, .61, .40, .90, .10, .58, .59].map((score, index) => ({ textPreview: `Synthetic evaluated body ${index}`, score })),
      { textPreview: 'Autor: Example Test', score: .95, presentationExcluded: true, excludedReason: 'METADATA' },
      { textPreview: 'References: Example Test (2026)', score: .96, presentationExcluded: true, excludedReason: 'REFERENCE_SECTION' },
    ]);
    const before = JSON.stringify(input);
    const output = buildTechnicalDisplayUnits(input.paragraphs, input.options);
    expect(output.counts).toMatchObject({ totalSegments: 10, evaluated: 10, rawFlaggedCount: 6, presentationExcludedFlagged: 2, actionableHighlightCount: 4 });
    expect(output.units.flatMap(unit => unit.sourceSegmentIds)).toEqual(input.paragraphs.map(segment => segment.paragraphIndex));
    expect(output.units.filter(unit => unit.type === 'EVALUATED_SEGMENT')).toHaveLength(8);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('rejects duplicate canonical source IDs rather than hiding duplicated segments', () => {
    const input = fixture([{ textPreview: 'first' }, { textPreview: 'second' }]);
    input.paragraphs[1]!.paragraphIndex = 0;
    expect(() => buildTechnicalDisplayUnits(input.paragraphs, input.options)).toThrow('TECHNICAL_DISPLAY_SOURCE_INVALID');
  });

  it('uses layout hints only when their persisted hash and offsets bind to the source segment', () => {
    const segment = { paragraphIndex: 2, textHash: 'synthetic-hash', charStart: 10, charEnd: 25 };
    const hint = { ...segment, structuralType: 'TABLE_CELL', structuralGroupId: 'table_1', kind: 'TABLE_CELL' };
    expect(presentationStructureHint({ presentationStructureHints: { 2: hint } }, segment)).toEqual({ structuralType: 'TABLE_CELL', structuralGroupId: 'table_1', kind: 'TABLE_CELL' });
    expect(presentationStructureHint({ presentationStructureHints: { 2: { ...hint, textHash: 'other' } } }, segment)).toEqual({});
    expect(presentationStructureHint({ presentationStructureHints: { 2: { ...hint, charEnd: 26 } } }, segment)).toEqual({});
  });
});
