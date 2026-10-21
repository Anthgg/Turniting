import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVisualReviewThresholdFixture, sha256 } from '../test/fixtures/reports/visual-review-threshold/fixture.mjs';

export { sha256 };

/** Browser QA consumes the same invented source and stored scores as the PDF tests. */
export async function createVisualReviewFixture() {
  const fixture = await createVisualReviewThresholdFixture();
  return {
    tag: 'F00943_SYNTHETIC_BROWSER_QA',
    filename: fixture.input.document.filename,
    source: fixture.source,
    sourceChecksum: fixture.input.document.sourceChecksum,
    paragraphs: fixture.input.paragraphs.map(segment => ({ ...segment, text: segment.textPreview, marker: `P${segment.paragraphIndex + 1}` })),
    scientificThreshold: fixture.input.run.threshold,
    globalScore: fixture.input.run.documentScore,
    expectedSourcePages: fixture.expectedSourcePages,
    expectedScientificMarkers: fixture.expectedScientificIds.map(index => `P${index + 1}`),
    expectedReviewMarkers: fixture.expectedReviewIds.map(index => `P${index + 1}`),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('EXACT_OUTPUT_DIRECTORY_REQUIRED');
  const destination = path.resolve(process.argv[2]);
  const fixture = await createVisualReviewFixture();
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, fixture.filename), fixture.source);
  const { source: _source, ...manifest } = fixture;
  await writeFile(path.join(destination, 'fixture.json'), JSON.stringify(manifest, null, 2));
  process.stdout.write(JSON.stringify({ ...manifest, paragraphs: fixture.paragraphs.length }) + '\n');
}
