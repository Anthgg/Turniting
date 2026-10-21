import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { PrismaClient } from '@prisma/client';
import { PDFArray, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { REVIEW_PRESENTATION_POLICY, shouldHighlightForReview } from '../dist/analysis/review-highlight-policy.js';
import { createReviewDocumentContext, getReviewEvidence } from '../dist/analysis/review-presentation.js';

const TAG = 'F00943_SYNTHETIC_BROWSER_QA';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const assert = (condition, code) => { if (!condition) throw new Error(code); };
const stable = value => value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => sha256(JSON.stringify(stable(value)));
const compact = text => text.normalize('NFC').replace(/\s+/gu, ' ').trim();

async function safeRead(rootInput, storageKey) {
  assert(rootInput && typeof storageKey === 'string' && UUID.test(storageKey.replace(/\.pdf$/u, '')) && storageKey.endsWith('.pdf'), 'EXACT_PDF_STORAGE_KEY_REQUIRED');
  const root = await realpath(rootInput);
  const target = path.resolve(root, storageKey);
  const stat = await lstat(target);
  const actual = await realpath(target);
  const relative = path.relative(root, actual);
  assert(stat.isFile() && !stat.isSymbolicLink() && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'STORAGE_SOURCE_OUTSIDE_ROOT');
  return readFile(actual);
}

function streams(document, pageIndex) {
  const contents = document.getPage(pageIndex).node.lookup(PDFName.of('Contents'));
  return (contents instanceof PDFArray ? contents.asArray() : [contents]).map(item => document.context.lookup(item)).filter(item => item instanceof PDFRawStream);
}
function decoded(stream) {
  return (stream.dict.get(PDFName.of('Filter'))?.toString() === '/FlateDecode' ? inflateSync(stream.contents) : Buffer.from(stream.contents)).toString('latin1');
}
function extractText(buffer) {
  return execFileSync('pdftotext', ['-enc', 'UTF-8', '-', '-'], { input: buffer, encoding: 'utf8', timeout: 20_000 });
}
function scientificSnapshot(run) {
  const { documentVersion, segments, modelResults, ...scalarRun } = run;
  return { run: digest(scalarRun), sourceVersion: digest(documentVersion), segments: digest(segments), models: digest(modelResults) };
}

/** Read-only live audit. It refuses every run without this exact synthetic QA marker. */
async function main() {
  const runId = process.argv[2];
  assert(process.argv.length === 3 && UUID.test(runId ?? ''), 'EXACT_SYNTHETIC_RUN_UUID_REQUIRED');
  assert(process.env.DATABASE_URL && ['db', 'postgres', 'database', 'localhost', '127.0.0.1', '[::1]', '::1', 'host.docker.internal'].includes(new URL(process.env.DATABASE_URL).hostname.toLowerCase()), 'LOCAL_DATABASE_REQUIRED');
  const prisma = new PrismaClient().$extends({ query: { $allModels: { $allOperations({ operation, args, query }) {
    assert(['findUnique', 'findFirst', 'findMany', 'count', 'aggregate', 'groupBy'].includes(operation), 'READ_ONLY_AUDIT_REQUIRED');
    return query(args);
  } } } });
  try {
    const marker = await prisma.analysisRun.findUnique({ where: { id: runId }, select: { metadata: true } });
    assert(marker?.metadata?.syntheticFixture === TAG && marker.metadata.synthetic === true, 'EXACT_SYNTHETIC_QA_MARKER_REQUIRED');
    const query = { where: { id: runId }, include: { documentVersion: true, segments: { orderBy: { paragraphIndex: 'asc' } }, modelResults: { orderBy: { modelName: 'asc' } } } };
    const run = await prisma.analysisRun.findUnique(query);
    assert(run?.metadata?.syntheticFixture === TAG && run.status === 'COMPLETED', 'COMPLETED_SYNTHETIC_RUN_REQUIRED');
    const before = scientificSnapshot(run);
    const version = run.documentVersion;
    assert(version.documentId === run.sourceDocumentId && version.id === run.sourceDocumentVersionId && version.id === run.documentVersionId && version.originalFilename === 'visual-review-threshold-fixture.pdf' && version.mimeType === 'application/pdf', 'SYNTHETIC_SOURCE_IDENTITY_MISMATCH');
    const source = await safeRead(process.env.UPLOAD_DIR, version.storageKey);
    assert(sha256(source) === version.fileHash && run.metadata.fixtureChecksum === version.fileHash, 'SYNTHETIC_SOURCE_CHECKSUM_MISMATCH');
    assert(run.segments.length === 7 && digest(run.segments.map(segment => segment.calibratedScore)) === digest([0.10, 0.20, 0.21, 0.35, 0.58, 0.59, 0.83]) && run.threshold === 0.59 && run.documentScore === 0.434, 'EXACT_SYNTHETIC_SCIENTIFIC_FIXTURE_REQUIRED');
    for (const segment of run.segments) assert(sha256(version.extractedText.slice(segment.charStart, segment.charEnd).replace(/\s+/gu, ' ').trim()) === segment.textHash, 'PERSISTED_SYNTHETIC_TEXT_HASH_MISMATCH');
    const context = createReviewDocumentContext(version.extractedText, run.segments);
    const evidence = run.segments.map(segment => getReviewEvidence(segment, run.threshold, context));
    const reviewIds = run.segments.filter((_, index) => shouldHighlightForReview(evidence[index])).map(segment => segment.paragraphIndex);
    const scientificIds = run.segments.filter((_, index) => evidence[index].flagged).map(segment => segment.paragraphIndex);
    assert(digest(reviewIds) === digest([2, 3, 4, 5, 6]) && digest(scientificIds) === digest([5, 6]), 'SYNTHETIC_REVIEW_DETECTOR_PARITY_FAILED');
    assert(evidence.every(item => !item.presentationExcluded), 'UNEXPECTED_SYNTHETIC_PRESENTATION_EXCLUSION');
    const candidates = await prisma.reportArtifact.findMany({ where: { analysisRunId: runId, documentId: version.documentId, status: 'AVAILABLE', deletedAt: null, type: { in: ['AI_ORIGINAL_REVIEW', 'AI_PARAGRAPH_TECHNICAL'] } }, orderBy: { generatedAt: 'desc' } });
    const variants = ['AI_ORIGINAL_REVIEW', 'AI_PARAGRAPH_TECHNICAL'];
    const reports = variants.map(type => candidates.find(artifact => artifact.type === type));
    assert(reports.every(Boolean), 'BOTH_SYNTHETIC_REPORTS_REQUIRED');
    const reportBytes = [];
    for (const artifact of reports) {
      const snapshot = artifact.analysisSnapshot;
      assert(artifact.generatedBy === 'TURNITING' && artifact.documentVersionId === version.id && artifact.sourceDocumentId === version.documentId && artifact.sourceDocumentVersionId === version.id && artifact.sourceChecksum === version.fileHash, 'REPORT_SOURCE_IDENTITY_MISMATCH');
      assert(snapshot?.source?.sourceArtifactType === 'DOCUMENT_VERSION' && snapshot.source.documentId === version.documentId && snapshot.source.documentVersionId === version.id && snapshot.source.sourceChecksum === version.fileHash, 'SNAPSHOT_SOURCE_IDENTITY_MISMATCH');
      assert(snapshot.run?.id === runId && snapshot.run.threshold === run.threshold && snapshot.run.globalScore === run.documentScore && digest(snapshot.run.modelNames) === digest(run.modelResults.map(model => model.modelName)), 'SCIENTIFIC_REPORT_SNAPSHOT_MISMATCH');
      assert(Object.entries(REVIEW_PRESENTATION_POLICY).every(([key, value]) => snapshot.presentation?.[key] === value) && snapshot.presentation.scientificFlaggedCount === scientificIds.length && snapshot.presentation.reviewHighlightedCount === reviewIds.length && digest(snapshot.presentation.reviewHighlightedSegmentIds) === digest(reviewIds), 'PRESENTATION_REPORT_SNAPSHOT_MISMATCH');
      const bytes = await safeRead(process.env.REPORT_STORAGE_ROOT, artifact.storageKey);
      assert(sha256(bytes) === artifact.contentHash, 'REPORT_CONTENT_HASH_MISMATCH');
      reportBytes.push(bytes);
    }
    const sourcePdf = await PDFDocument.load(source);
    const originalPdf = await PDFDocument.load(reportBytes[0]);
    const technicalPdf = await PDFDocument.load(reportBytes[1]);
    assert(originalPdf.getPageCount() === sourcePdf.getPageCount() + 1, 'ORIGINAL_PAGE_COUNT_CHANGED');
    const technicalHashes = new Set(technicalPdf.getPages().flatMap((_, index) => streams(technicalPdf, index).map(stream => sha256(stream.contents))));
    let sourceStreams = 0;
    const overlays = [];
    for (let pageIndex = 0; pageIndex < sourcePdf.getPageCount(); pageIndex += 1) {
      const sourceHashes = new Set(streams(sourcePdf, pageIndex).map(stream => sha256(stream.contents)));
      const pageStreams = streams(originalPdf, pageIndex + 1);
      for (const hash of sourceHashes) assert(pageStreams.some(stream => sha256(stream.contents) === hash), 'ORIGINAL_SOURCE_STREAM_CHANGED');
      sourceStreams += sourceHashes.size;
      assert(pageStreams.every(stream => !technicalHashes.has(sha256(stream.contents))), 'TECHNICAL_REPORT_NESTED_IN_ORIGINAL');
      for (const stream of pageStreams.filter(item => !sourceHashes.has(sha256(item.contents)))) {
        const drawing = decoded(stream);
        assert(!/\b(?:Tj|TJ|BT)\b/u.test(drawing), 'LOCAL_TEXT_ADDED_TO_ORIGINAL_SOURCE_PAGE');
        if (!drawing.includes('1 0.84 0.18 rg')) continue;
        // A rectangle also emits identity rotation/skew matrices; capture its first translation only.
        for (const match of drawing.matchAll(/1 0\.84 0\.18 rg[\s\S]*?1\s+0\s+0\s+1\s+([\d.-]+)\s+([\d.-]+)\s+cm/gu)) overlays.push({ pageIndex, x: Number(match[1]), y: Number(match[2]) });
      }
    }
    const maps = await prisma.documentLayoutMap.findMany({ where: { analysisRunId: runId, documentId: version.documentId, documentVersionId: version.id, sourceChecksum: version.fileHash, deletedAt: null }, orderBy: { createdAt: 'desc' } });
    const map = maps.find(item => item.layoutMap?.source?.analysisRunId === runId)?.layoutMap;
    assert(map && map.source.sourceArtifactType === 'DOCUMENT_VERSION' && map.source.sourceChecksum === version.fileHash, 'SYNTHETIC_LAYOUT_SOURCE_MISMATCH');
    const highlightedSegmentIds = [];
    let expectedRectangles = 0;
    for (const segment of map.segments) {
      const matched = segment.rectangles.map(rectangle => {
        const page = originalPdf.getPage(rectangle.pageIndex + 1);
        assert(page.getRotation().angle === 0, 'SYNTHETIC_UNROTATED_SOURCE_REQUIRED');
        const crop = page.getCropBox(); const layout = map.pages[rectangle.pageIndex];
        const x = crop.x + rectangle.x * crop.width / layout.width;
        const y = crop.y + crop.height - (rectangle.y + rectangle.height) * crop.height / layout.height;
        return overlays.some(overlay => overlay.pageIndex === rectangle.pageIndex && Math.abs(overlay.x - x) < 0.02 && Math.abs(overlay.y - y) < 0.02);
      });
      if (matched.some(Boolean)) { assert(matched.every(Boolean), 'PARTIAL_SEGMENT_OVERLAY'); highlightedSegmentIds.push(segment.segmentId); expectedRectangles += segment.rectangles.length; }
    }
    if (digest(highlightedSegmentIds) !== digest(reviewIds) || expectedRectangles !== overlays.length) {
      process.stderr.write(JSON.stringify({ event: 'synthetic_overlay_parity_failed', highlightedSegmentIds, reviewIds, expectedRectangles, actualRectangles: overlays.length, overlays }) + '\n');
      throw new Error('WEB_PDF_ACTUAL_OVERLAY_PARITY_FAILED');
    }
    const originalText = extractText(reportBytes[0]);
    const cover = compact(originalText.split('\f')[0]);
    const sourcePagesText = compact(originalText.split('\f').slice(1).join(' '));
    assert(!sourcePagesText.includes('%'), 'LOCAL_PERCENTAGE_ADDED_TO_ORIGINAL_SOURCE_PAGE');
    assert(cover.includes('Umbral detector 59.0 %') && cover.includes('Umbral revisión visual >20.0 %') && /Señalados por detector\s+2/u.test(cover) && /Resaltados para revisión\s+5/u.test(cover), 'ORIGINAL_COVER_THRESHOLD_OR_COUNT_MISMATCH');
    const technicalText = compact(extractText(reportBytes[1]));
    for (const segment of run.segments) {
      const label = new RegExp(`(?:PÁRRAFO|SEGMENTO) ${segment.paragraphIndex + 1}(?!\\d)`, 'u').exec(technicalText);
      const start = label?.index ?? -1;
      const end = technicalText.indexOf('The synthetic body', start);
      const card = technicalText.slice(start, end);
      const detector = scientificIds.includes(segment.paragraphIndex) ? 'SEÑALADO' : 'NO SEÑALADO';
      const review = reviewIds.includes(segment.paragraphIndex) ? 'RESALTADO' : 'NO RESALTADO';
      if (!(start >= 0 && end > start && card.includes(`Detector: ${detector}`) && card.includes(`Señal local estimada: ${(segment.calibratedScore * 100).toFixed(1)} %`) && card.includes(`Revisión visual: ${review}`))) {
        process.stderr.write(JSON.stringify({ event: 'synthetic_technical_state_mismatch', segmentIndex: segment.paragraphIndex, start, end, card }) + '\n');
        throw new Error('TECHNICAL_SEGMENT_STATE_MISMATCH');
      }
      assert(sourcePagesText.includes(compact(version.extractedText.slice(segment.charStart, segment.charEnd))), 'SOURCE_SEGMENT_TEXT_MISSING');
    }
    const after = scientificSnapshot(await prisma.analysisRun.findUnique(query));
    assert(digest(before) === digest(after), 'SCIENTIFIC_OR_SOURCE_DATA_MUTATED_DURING_AUDIT');
    if (process.env.F00943_COPY_PDFS === '1') {
      const directory = await mkdtemp(path.join(tmpdir(), 'f00943-synthetic-audit-'));
      await writeFile(path.join(directory, 'original-review.pdf'), reportBytes[0], { flag: 'wx', mode: 0o600 });
      await writeFile(path.join(directory, 'paragraph-technical.pdf'), reportBytes[1], { flag: 'wx', mode: 0o600 });
      process.stderr.write(JSON.stringify({ event: 'verified_synthetic_pdf_export', directory }) + '\n');
    }
    process.stdout.write(JSON.stringify({ status: 'PASS', phase: 'F009_4_3_VISUAL_REVIEW_THRESHOLD', syntheticFixture: TAG, privateDocumentUsed: false, inferenceExecuted: false,
      documentId: version.documentId, documentVersionId: version.id, analysisRunId: runId, sourceChecksum: version.fileHash,
      scientific: { globalScore: run.documentScore, threshold: run.threshold, modelNames: run.modelResults.map(model => model.modelName), flaggedCount: scientificIds.length, flaggedSegmentIds: scientificIds },
      presentation: { ...REVIEW_PRESENTATION_POLICY, reviewHighlightedCount: reviewIds.length, reviewHighlightedSegmentIds: reviewIds, actualOriginalOverlaySegmentIds: highlightedSegmentIds, actualOverlayRectangles: overlays.length },
      reports: reports.map((artifact, index) => ({ id: artifact.id, type: artifact.type, generationVersion: artifact.generationVersion, sha256: sha256(reportBytes[index]), pages: index === 0 ? originalPdf.getPageCount() : technicalPdf.getPageCount(), snapshotPolicy: artifact.analysisSnapshot.presentation, scientificSnapshotDigest: digest(artifact.analysisSnapshot.run) })),
      integrity: { readOnlyDatabaseQueries: true, sourceStreamsPreserved: sourceStreams, sourcePages: sourcePdf.getPageCount(), noNestedReports: true, originalSourcePageLocalPercentages: false, technicalScoresAndStatesExact: true, webPdfActualOverlayParity: true, scientificAndSourceDigestsUnchanged: true, before, after } }, null, 2) + '\n');
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { process.stderr.write((error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : 'SYNTHETIC_REPORT_AUDIT_FAILED') + '\n'); process.exitCode = 1; });
