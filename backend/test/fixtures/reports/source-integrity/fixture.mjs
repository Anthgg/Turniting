import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';

export const FIXTURE_IDS = {
  documentId: 'f0094100-0000-4000-8000-000000000001',
  documentVersionId: 'f0094100-0000-4000-8000-000000000002',
  analysisRunId: 'f0094100-0000-4000-8000-000000000003',
  technicalReportId: 'f0094100-0000-4000-8000-000000000004',
  originalReportId: 'f0094100-0000-4000-8000-000000000005',
};

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function wrapText(text, font, width, size) {
  const lines = [];
  let current = '';
  for (const word of text.split(/\s+/u)) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(candidate, size) > width) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Generated sample material only. Scores describe a persisted test run. */
export async function createSourceIntegrityFixture() {
  const now = new Date('2026-10-20T12:00:00.000Z');
  const bodyScores = [0.8, 0.2, 0.61, 0.4, 0.9, 0.1, 0.58, 0.59];
  const subjects = [
    'Sample orchard measurements', 'Synthetic river observations',
    'Generated workshop inventory', 'Imaginary school attendance',
    'Example laboratory notebooks', 'Fictional garden experiments',
    'Demonstration library catalogues', 'Illustrative weather stations',
  ];
  const descriptions = [
    { text: 'Autor: Synthetic Fixture. Institution: Example Test Laboratory. Date: 2026.', score: 0.95, excludedReason: 'METADATA', sourcePageIndex: 0 },
    ...subjects.map((subject, index) => ({
      text: `${subject} provide a distinct canonical paragraph numbered ${index + 1}. ` +
        'This generated study explains how a small team records measurements, compares observations, and documents reproducible decisions. ' +
        'Each entry uses invented values and contains no personal information, customer material, or copied academic document. ' +
        'Researchers review the collection procedure before grouping the sample records into a transparent sequence of practical steps. ' +
        'The interpretation considers sampling limitations, differences between repeated observations, and the need to preserve the original evidence. ' +
        'A later reviewer can trace the conclusion to these written notes because the complete paragraph remains unchanged in the persisted analysis. ' +
        `Its unique closing phrase is source integrity body ${index + 1} complete.`,
      score: bodyScores[index], sourcePageIndex: index + 1,
    })),
    { text: 'Short note.', score: null, excludedReason: 'INSUFFICIENT_TEXT', sourcePageIndex: 9 },
    { text: 'Brief item.', score: null, excludedReason: 'INSUFFICIENT_TEXT', sourcePageIndex: 10 },
    { text: 'References: Synthetic Laboratory (2026). Invented source integrity study. Example Test Press.', score: 0.96, excludedReason: 'REFERENCE_SECTION', sourcePageIndex: 11 },
  ];
  let cursor = 0;
  const paragraphs = descriptions.map((entry, paragraphIndex) => {
    const start = cursor;
    cursor += entry.text.length + 2;
    const excluded = Boolean(entry.excludedReason);
    const signalLevel = entry.score === null ? null : entry.score >= 0.59 ? 'HIGH' : 'LOW';
    return {
      paragraphIndex,
      textHash: sha256(entry.text),
      charStart: start,
      charEnd: start + entry.text.length,
      segmentEvidence: { type: 'PARAGRAPH', paragraphId: paragraphIndex, start, end: start + entry.text.length, score: entry.score, level: signalLevel },
      reviewPresentation: { highlight: !excluded && entry.score >= 0.59, level: signalLevel, ...(entry.excludedReason ? { excludedReason: entry.excludedReason } : {}) },
      presentationExcluded: excluded,
      ...(entry.excludedReason ? { excludedReason: entry.excludedReason } : {}),
      score: entry.score,
      signalLevel,
      classification: entry.score === null ? 'INSUFFICIENT_TEXT' : entry.score >= 0.59 ? 'HIGH_SIGNAL' : 'LOW_SIGNAL',
      textPreview: entry.text,
      pageNumber: entry.sourcePageIndex + 1,
      words: entry.text.split(/\s+/u).length,
      tokens: entry.text.split(/\s+/u).length,
    };
  });
  const sourcePdf = await PDFDocument.create();
  sourcePdf.setTitle('thesis-fixture.pdf - synthetic original source');
  sourcePdf.setProducer('Synthetic fixture generator');
  sourcePdf.setCreationDate(now);
  sourcePdf.setModificationDate(now);
  const font = await sourcePdf.embedFont(StandardFonts.Helvetica);
  for (let pageIndex = 0; pageIndex < 18; pageIndex += 1) {
    const page = sourcePdf.addPage([595.28, 841.89]);
    page.drawText(`THESIS ORIGINAL SOURCE PAGE ${pageIndex + 1} OF 18`, { x: 48, y: 790, size: 10, font });
    const entry = descriptions.find((item) => item.sourcePageIndex === pageIndex);
    const lines = wrapText(entry?.text ?? `Original appendix page ${pageIndex + 1} preserves source-only page content.`, font, 499, 10);
    lines.forEach((line, lineIndex) => page.drawText(line, { x: 48, y: 744 - lineIndex * 15, size: 10, font }));
    page.drawText('SYNTHETIC SOURCE - NO PRIVATE DOCUMENT', { x: 48, y: 40, size: 8, font });
  }
  const source = Buffer.from(await sourcePdf.save());
  const input = {
    reportId: FIXTURE_IDS.originalReportId, generatedAt: now, turnitingVersion: 'synthetic-f0094.1',
    document: { id: FIXTURE_IDS.documentId, documentVersionId: FIXTURE_IDS.documentVersionId, filename: 'thesis-fixture.pdf', mimeType: 'application/pdf', sourceChecksum: sha256(source), storageKey: 'f0094100-0000-4000-8000-000000000010.pdf', createdAt: now, updatedAt: now },
    extractedText: paragraphs.map((item) => item.textPreview).join('\n\n'),
    run: { id: FIXTURE_IDS.analysisRunId, status: 'COMPLETED', analyzerMode: 'ENSEMBLE_V2_V3', analyzerVersion: 'synthetic-persisted-v1', thresholdProfile: 'BALANCED', threshold: 0.59, paragraphMode: 'STRICT_PARAGRAPH', documentAggregation: 'token_weighted_mean', documentScore: 0.434, signalLevel: 'MODERATE', scoredSegments: 10, insufficientSegments: 2, inferenceMs: 1, cacheHit: false, metadata: { synthetic: true, calibration: 'synthetic-persisted' }, createdAt: now, completedAt: now, modelNames: ['SYNTHETIC_MODEL'], modelVersions: ['synthetic-v1'] },
    paragraphs, history: [], limitations: ['Synthetic regression fixture; no private material.'],
  };
  return { source, input, bodyScores, expectedSourcePages: 18, expectedOriginalReviewPages: 19, expectedActionableFlagged: 4 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDirectory = path.resolve(process.argv[2] ?? '.');
  const fixture = await createSourceIntegrityFixture();
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, 'thesis-fixture.pdf'), fixture.source);
  await writeFile(path.join(outputDirectory, 'thesis-fixture.run.json'), JSON.stringify(fixture.input, null, 2));
  process.stdout.write(JSON.stringify({ sourceFilename: 'thesis-fixture.pdf', sourceChecksum: fixture.input.document.sourceChecksum, pages: fixture.expectedSourcePages, segments: fixture.input.paragraphs.length, bodyEvaluable: 8, insufficient: 2, metadata: 1, references: 1, actionableFlagged: fixture.expectedActionableFlagged }) + '\n');
}
