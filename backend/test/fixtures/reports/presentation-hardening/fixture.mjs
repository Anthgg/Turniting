import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';

export const FIXTURE_IDS = {
  documentId: 'f0094200-0000-4000-8000-000000000001',
  documentVersionId: 'f0094200-0000-4000-8000-000000000002',
  analysisRunId: 'f0094200-0000-4000-8000-000000000003',
  technicalReportId: 'f0094200-0000-4000-8000-000000000004',
  originalReportId: 'f0094200-0000-4000-8000-000000000005',
};
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function lines(text, font, size, width) {
  const result = [];
  let line = '';
  for (const word of text.split(/\s+/u)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(candidate, size) > width) {
      result.push(line);
      line = word;
    } else line = candidate;
  }
  if (line) result.push(line);
  return result;
}

/** Synthetic original source and an immutable, persisted-score presentation fixture. */
export async function createPresentationHardeningFixture() {
  const now = new Date('2026-10-20T15:00:00.000Z');
  const bodyScores = [0.8, 0.2, 0.61, 0.4, 0.9, 0.1, 0.58, 0.25];
  const metadata = ['Autor: Synthetic QA Example', 'FACULTAD DE CIENCIAS SINTETICAS', 'ESCUELA DE SISTEMAS DE PRUEBA', 'Universidad: Example Test Laboratory', 'Autores: Generated Fixture Team', 'ORCID: 0000-0000-0000-0000', 'Asesor: Synthetic Test Mentor', 'Correo: sample@example.invalid', 'Fecha: 2026', 'Ciudad: Example Test City'];
  const body = bodyScores.map((score, index) => ({
    text: `The synthetic body paragraph numbered ${index + 1} describes a distinct reproducible observation. ` +
      'A small research team collects invented measurements and writes a transparent record of its decisions before comparing the sample outcomes. ' +
      'Every value is fictional and every sentence exists only to exercise the document presentation workflow without private information. ' +
      'The procedure keeps canonical source text available for a later reviewer and separates the detector score from the visual organization of a report. ' +
      'An evaluated segment retains its original probability and threshold even when neighbouring table cells or bibliography fragments are displayed together. ' +
      `This paragraph ends with unique body marker ${index + 1}.`,
    score, kind: 'PARAGRAPH', pageIndex: index < 4 ? index + 1 : index + 2,
  }));
  const entries = [
    ...metadata.map((text, index) => ({ text, score: index === 0 ? 0.95 : null, kind: 'METADATA', structuralType: 'METADATA', structuralGroupId: 'metadata-cover', excludedReason: 'METADATA', pageIndex: 0 })),
    ...body.slice(0, 4),
    ...Array.from({ length: 20 }, (_, index) => ({ text: `Table cell ${String(index + 1).padStart(2, '0')} | Indicator ${index + 1} | Value ${index + 11}`, score: null, kind: 'TABLE_CELL', structuralType: 'TABLE_CELL', structuralGroupId: 'synthetic-table-1', excludedReason: 'INSUFFICIENT_TEXT', pageIndex: 5 })),
    ...body.slice(4),
    ...Array.from({ length: 30 }, (_, index) => ({ text: `${index === 0 ? 'References: ' : ''}[${index + 1}] Synthetic Author ${index + 1} (2026). Generated reference entry ${index + 1}. Example Test Press.`, score: index === 0 ? 0.91 : null, kind: 'REFERENCE_SECTION', structuralType: 'REFERENCE_SECTION', structuralGroupId: 'synthetic-reference-section', excludedReason: 'REFERENCE_SECTION', pageIndex: index < 15 ? 10 : 11 })),
  ];
  let offset = 0;
  const paragraphs = entries.map((entry, paragraphIndex) => {
    const charStart = offset;
    const charEnd = charStart + entry.text.length;
    offset = charEnd + 2;
    const signalLevel = entry.score === null ? null : entry.score >= 0.59 ? 'HIGH' : 'LOW';
    return {
      paragraphIndex, sourceSegmentId: `synthetic-f00942-${paragraphIndex}`, kind: entry.kind,
      ...(entry.structuralType ? { structuralType: entry.structuralType } : {}),
      ...(entry.structuralGroupId ? { structuralGroupId: entry.structuralGroupId } : {}),
      textHash: sha256(entry.text.replace(/\s+/gu, ' ').trim()), charStart, charEnd,
      segmentEvidence: { type: 'PARAGRAPH', paragraphId: paragraphIndex, start: charStart, end: charEnd, score: entry.score, level: signalLevel },
      score: entry.score, signalLevel,
      classification: entry.score === null ? 'INSUFFICIENT_TEXT' : entry.score >= 0.59 ? 'MACHINE_SIGNAL' : 'LOW_SIGNAL',
      reviewPresentation: { highlight: entry.score !== null && entry.score >= 0.59 && !entry.excludedReason, level: signalLevel, ...(entry.excludedReason ? { excludedReason: entry.excludedReason } : {}) },
      presentationExcluded: Boolean(entry.excludedReason),
      ...(entry.excludedReason ? { excludedReason: entry.excludedReason } : {}),
      textPreview: entry.text, pageNumber: entry.pageIndex + 1, words: entry.text.split(/\s+/u).length, tokens: entry.text.split(/\s+/u).length,
    };
  });
  const pdf = await PDFDocument.create();
  pdf.setTitle('presentation-hardening-fixture.pdf - synthetic source');
  pdf.setProducer('Synthetic fixture generator');
  pdf.setCreationDate(now); pdf.setModificationDate(now);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let pageIndex = 0; pageIndex < 18; pageIndex += 1) {
    const page = pdf.addPage([595.28, 841.89]);
    page.drawText(`STRUCTURAL ORIGINAL SOURCE PAGE ${pageIndex + 1} OF 18`, { x: 48, y: 790, font, size: 10 });
    const pageEntries = entries.filter((entry) => entry.pageIndex === pageIndex);
    let y = 744;
    for (const entry of pageEntries) {
      const size = entry.kind === 'PARAGRAPH' ? 10 : 9;
      const wrapped = lines(entry.text, font, size, 499);
      for (const line of wrapped) { page.drawText(line, { x: 48, y, font, size }); y -= 14; }
      y -= entry.kind === 'REFERENCE_SECTION' ? 16 : 8;
    }
    if (!pageEntries.length) page.drawText(`Synthetic source appendix ${pageIndex + 1} retains original page content.`, { x: 48, y: 744, font, size: 10 });
    page.drawText('SYNTHETIC SOURCE - NO PRIVATE DOCUMENT', { x: 48, y: 40, font, size: 8 });
  }
  const source = Buffer.from(await pdf.save());
  const input = {
    reportId: FIXTURE_IDS.technicalReportId, generatedAt: now, turnitingVersion: 'synthetic-f0094.2',
    document: { id: FIXTURE_IDS.documentId, documentVersionId: FIXTURE_IDS.documentVersionId, filename: 'presentation-hardening-fixture.pdf', mimeType: 'application/pdf', sourceChecksum: sha256(source), storageKey: 'f0094200-0000-4000-8000-000000000010.pdf', createdAt: now, updatedAt: now },
    extractedText: paragraphs.map((paragraph) => paragraph.textPreview).join('\n\n'),
    run: { id: FIXTURE_IDS.analysisRunId, status: 'COMPLETED', analyzerMode: 'ENSEMBLE', analyzerVersion: 'synthetic-persisted-f00942', thresholdProfile: 'SYNTHETIC_FIXTURE', threshold: 0.59, paragraphMode: 'STRICT_PARAGRAPH', documentAggregation: 'SYNTHETIC_PERSISTED_SCORE', documentScore: 0.434, signalLevel: 'MODERATE', scoredSegments: 10, insufficientSegments: 58, inferenceMs: 0, cacheHit: false, metadata: { synthetic: true }, createdAt: now, completedAt: now, modelNames: ['SYNTHETIC_F00942_PERSISTED_SCORES'], modelVersions: ['synthetic-fixture-v1'] },
    paragraphs, history: [], limitations: ['Generated synthetic fixture; no private document or live inference.'],
  };
  const presentationStructureHints = Object.fromEntries(paragraphs.map((paragraph) => [String(paragraph.paragraphIndex), { kind: paragraph.kind, ...(paragraph.structuralType ? { structuralType: paragraph.structuralType } : {}), ...(paragraph.structuralGroupId ? { structuralGroupId: paragraph.structuralGroupId } : {}) }]));
  return { source, input, bodyScores, presentationStructureHints, expectedSourcePages: 18, expectedOriginalReviewPages: 19, expectedBodyFlagged: 3, expectedRawFlagged: 5, expectedPresentationExcludedFlagged: 2 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = path.resolve(process.argv[2] ?? '.');
  const fixture = await createPresentationHardeningFixture();
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'presentation-hardening-fixture.pdf'), fixture.source);
  await writeFile(path.join(destination, 'presentation-hardening-fixture.run.json'), JSON.stringify({ input: fixture.input, presentationStructureHints: fixture.presentationStructureHints }, null, 2));
  process.stdout.write(JSON.stringify({ sourceFilename: fixture.input.document.filename, sourceChecksum: fixture.input.document.sourceChecksum, pages: 18, segments: 68, body: 8, table: 20, metadata: 10, references: 30, bodyFlagged: 3 }) + '\n');
}
