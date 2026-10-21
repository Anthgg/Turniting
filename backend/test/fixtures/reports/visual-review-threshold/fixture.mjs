import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';

export const FIXTURE_IDS = {
  documentId: 'f0094300-0000-4000-8000-000000000001',
  documentVersionId: 'f0094300-0000-4000-8000-000000000002',
  analysisRunId: 'f0094300-0000-4000-8000-000000000003',
  technicalReportId: 'f0094300-0000-4000-8000-000000000004',
  originalReportId: 'f0094300-0000-4000-8000-000000000005',
};
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** Invented source and stored scores; no inference, private document or training input. */
export async function createVisualReviewThresholdFixture() {
  const now = new Date('2026-10-20T18:00:00.000Z');
  const scores = [0.10, 0.20, 0.21, 0.35, 0.58, 0.59, 0.83];
  const texts = scores.map((_, index) => `The synthetic body paragraph numbered ${index + 1} records a distinct invented observation. Every measurement is fictional and exists solely to check visual review independently from the detector decision. Source marker ${index + 1} remains unchanged.`);
  const document = await PDFDocument.create();
  document.setTitle('visual-review-threshold-fixture.pdf - synthetic source');
  document.setProducer('Synthetic fixture generator');
  document.setCreationDate(now); document.setModificationDate(now);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([595.28, 841.89]);
  page.drawText('SYNTHETIC VISUAL REVIEW SOURCE', { x: 48, y: 790, size: 12, font });
  for (let index = 0; index < texts.length; index += 1) {
    page.drawText(texts[index], { x: 48, y: 742 - index * 88, size: 10, font, maxWidth: 499, lineHeight: 14 });
  }
  page.drawText('SYNTHETIC SOURCE - NO PRIVATE DOCUMENT', { x: 48, y: 40, size: 8, font });
  const source = Buffer.from(await document.save());
  let offset = 0;
  const paragraphs = texts.map((text, paragraphIndex) => {
    const score = scores[paragraphIndex];
    const charStart = offset;
    const charEnd = charStart + text.length;
    offset = charEnd + 2;
    const flagged = score >= 0.59;
    const signalLevel = flagged ? 'HIGH' : 'LOW';
    return {
      paragraphIndex, sourceSegmentId: `synthetic-f00943-${paragraphIndex}`, kind: 'PARAGRAPH',
      textHash: sha256(text), charStart, charEnd, score, signalLevel,
      classification: flagged ? 'MACHINE_SIGNAL' : 'LOW_SIGNAL', flagged,
      // Legacy presentation intentionally remains detector based to exercise regeneration.
      reviewPresentation: { highlight: flagged, level: signalLevel }, presentationExcluded: false,
      segmentEvidence: { type: 'PARAGRAPH', paragraphId: paragraphIndex, start: charStart, end: charEnd, score, level: signalLevel },
      textPreview: text, pageNumber: 1, words: text.split(/\s+/u).length, tokens: text.split(/\s+/u).length,
    };
  });
  const input = {
    reportId: FIXTURE_IDS.technicalReportId, generatedAt: now, turnitingVersion: 'synthetic-f0094.3',
    document: { id: FIXTURE_IDS.documentId, documentVersionId: FIXTURE_IDS.documentVersionId, filename: 'visual-review-threshold-fixture.pdf', mimeType: 'application/pdf', sourceChecksum: sha256(source), storageKey: 'f0094300-0000-4000-8000-000000000010.pdf', createdAt: now, updatedAt: now },
    extractedText: texts.join('\n\n'),
    run: { id: FIXTURE_IDS.analysisRunId, status: 'COMPLETED', analyzerMode: 'ENSEMBLE', analyzerVersion: 'synthetic-persisted-f00943', thresholdProfile: 'SYNTHETIC_FIXTURE', threshold: 0.59, paragraphMode: 'STRICT_PARAGRAPH', documentAggregation: 'SYNTHETIC_PERSISTED_SCORE', documentScore: 0.434, signalLevel: 'MODERATE', scoredSegments: 7, insufficientSegments: 0, inferenceMs: 0, cacheHit: false, metadata: { synthetic: true }, createdAt: now, completedAt: now, modelNames: ['SYNTHETIC_F00943_PERSISTED_SCORES'], modelVersions: ['synthetic-fixture-v1'] },
    paragraphs, history: [], limitations: ['Generated synthetic fixture; no private document or live inference.'],
  };
  const presentationStructureHints = Object.fromEntries(paragraphs.map((segment) => [String(segment.paragraphIndex), { kind: segment.kind }]));
  return { source, input, scores, presentationStructureHints, expectedSourcePages: 1, expectedOriginalReviewPages: 2, expectedScientificIds: [5, 6], expectedReviewIds: [2, 3, 4, 5, 6] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = path.resolve(process.argv[2] ?? '.');
  const fixture = await createVisualReviewThresholdFixture();
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, fixture.input.document.filename), fixture.source);
  await writeFile(path.join(destination, 'visual-review-threshold-fixture.run.json'), JSON.stringify({ input: fixture.input, presentationStructureHints: fixture.presentationStructureHints }, null, 2));
  process.stdout.write(JSON.stringify({ filename: fixture.input.document.filename, checksum: fixture.input.document.sourceChecksum, sourcePages: 1, segments: 7, scientificFlagged: 2, reviewHighlighted: 5 }) + '\n');
}
