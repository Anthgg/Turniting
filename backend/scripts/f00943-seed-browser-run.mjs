import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createVisualReviewFixture, sha256 } from './f00943-browser-fixture.mjs';
import { createReviewDocumentContext, getReviewEvidence, normalizeReviewSegmentOffsets } from '../dist/analysis/review-presentation.js';

const MODEL = 'SYNTHETIC_F00943_PERSISTED_SCORES';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function requireCondition(condition, code) { if (!condition) throw new Error(code); }
function escaped(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
function stable(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function digest(value) { return sha256(JSON.stringify(stable(value))); }

/** Adds one new QA-labelled run to the exact freshly uploaded fixture; never updates any run. */
async function main() {
  const documentId = process.argv[2];
  const expectedVersionId = process.argv[3];
  requireCondition(process.argv.length === 4 && uuidPattern.test(documentId ?? '') && uuidPattern.test(expectedVersionId ?? ''), 'EXACT_SYNTHETIC_DOCUMENT_AND_VERSION_IDS_REQUIRED');
  const databaseUrl = process.env.DATABASE_URL;
  requireCondition(databaseUrl && ['db', 'postgres', 'database', 'localhost', '127.0.0.1', '[::1]', '::1', 'host.docker.internal'].includes(new URL(databaseUrl).hostname.toLowerCase()), 'LOCAL_DATABASE_REQUIRED');
  const fixture = await createVisualReviewFixture();
  const prisma = new PrismaClient();
  try {
    const document = await prisma.document.findUnique({ where: { id: documentId }, include: { currentVersion: { include: { analysisRuns: true } } } });
    const version = document?.currentVersion;
    requireCondition(document && version && version.id === expectedVersionId && version.documentId === documentId, 'EXACT_SYNTHETIC_SOURCE_REQUIRED');
    requireCondition(document.originalName === fixture.filename && version.originalFilename === fixture.filename && document.mimeType === 'application/pdf' && version.mimeType === 'application/pdf', 'EXACT_SYNTHETIC_FILENAME_AND_TYPE_REQUIRED');
    requireCondition(document.status === 'EXTRACTED' && version.fileHash === fixture.sourceChecksum && version.ingestionOrigin === 'USER_UPLOAD' && version.pageCount === fixture.expectedSourcePages && !version.requiresOcr && typeof version.extractedText === 'string', 'EXACT_SYNTHETIC_SOURCE_CHECKSUM_REQUIRED');
    requireCondition(version.analysisRuns.length === 0, 'FRESH_SYNTHETIC_DOCUMENT_WITH_ZERO_RUNS_REQUIRED');
    requireCondition(process.env.UPLOAD_DIR && uuidPattern.test(version.storageKey.replace(/\.pdf$/u, '')) && version.storageKey.endsWith('.pdf'), 'UPLOAD_SOURCE_REQUIRED');
    const root = await realpath(process.env.UPLOAD_DIR);
    const target = path.resolve(root, version.storageKey);
    const stats = await lstat(target);
    const actual = await realpath(target);
    const relative = path.relative(root, actual);
    requireCondition(stats.isFile() && !stats.isSymbolicLink() && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'UPLOAD_SOURCE_OUTSIDE_ROOT');
    requireCondition(sha256(await readFile(actual)) === fixture.sourceChecksum, 'UPLOAD_BYTES_MISMATCH');
    let cursor = 0;
    const segments = fixture.paragraphs.map(paragraph => {
      const match = new RegExp(paragraph.text.split(/\s+/u).map(escaped).join('\\s+'), 'u').exec(version.extractedText.slice(cursor));
      requireCondition(match, 'CANONICAL_SYNTHETIC_TEXT_NOT_FOUND');
      const charStart = cursor + match.index;
      const charEnd = charStart + match[0].length;
      cursor = charEnd;
      return { paragraphIndex: paragraph.paragraphIndex, charStart, charEnd, textHash: sha256(match[0].replace(/\s+/gu, ' ').trim()),
        pageNumber: paragraph.pageNumber, words: paragraph.text.split(/\s+/u).length, tokens: paragraph.text.split(/\s+/u).length,
        rawScore: paragraph.score, calibratedScore: paragraph.score, classification: paragraph.score >= fixture.scientificThreshold ? 'MACHINE_SIGNAL' : 'LOW_SIGNAL',
        signalLevel: paragraph.score >= fixture.scientificThreshold ? 'HIGH' : 'LOW', confidence: 'SYNTHETIC_PERSISTED_FIXTURE', modelName: MODEL };
    });
    const normalized = normalizeReviewSegmentOffsets(version.extractedText, segments);
    requireCondition(normalized.length === 7 && normalized.every((segment, index) => segment.charStart === segments[index].charStart && segment.charEnd === segments[index].charEnd), 'SYNTHETIC_OFFSETS_CHANGED');
    const context = createReviewDocumentContext(version.extractedText, normalized);
    const evidence = normalized.map(segment => getReviewEvidence(segment, fixture.scientificThreshold, context));
    requireCondition(evidence.filter(item => item.flagged).length === 2 && evidence.every(item => !item.presentationExcluded), 'SYNTHETIC_SCIENTIFIC_OR_EXCLUSION_VALIDATION_FAILED');
    const highlightedIndices = evidence.flatMap((item, index) => item.reviewHighlighted ? [index] : []);
    requireCondition(highlightedIndices.length === 5 && digest(highlightedIndices) === digest(fixture.expectedReviewMarkers.map(marker => Number(marker.slice(1)) - 1)), 'SYNTHETIC_VISUAL_POLICY_VALIDATION_FAILED');
    const { analysisRuns: _analysisRuns, ...sourceVersion } = version;
    const sourceBefore = digest(sourceVersion);
    const run = await prisma.$transaction(async transaction => {
      const fresh = await transaction.documentVersion.findUnique({ where: { id: version.id } });
      requireCondition(fresh && digest(fresh) === sourceBefore, 'SYNTHETIC_SOURCE_CHANGED');
      requireCondition(await transaction.analysisRun.count({ where: { documentVersionId: version.id } }) === 0, 'FRESH_SYNTHETIC_DOCUMENT_WITH_ZERO_RUNS_REQUIRED');
      return transaction.analysisRun.create({ data: {
        documentVersionId: version.id, sourceDocumentId: documentId, sourceDocumentVersionId: version.id,
        status: 'COMPLETED', analyzerMode: 'ENSEMBLE', analyzerVersion: fixture.tag, thresholdProfile: 'SYNTHETIC_FIXTURE',
        threshold: fixture.scientificThreshold, granularity: 'PARAGRAPH', paragraphMode: 'STRICT_PARAGRAPH', documentAggregation: 'SYNTHETIC_PERSISTED_SCORE',
        documentScore: fixture.globalScore, documentClassification: 'LOW_SIGNAL', signalLevel: 'MODERATE', scoredSegments: 7,
        insufficientSegments: 0, inferenceMs: 0, completedAt: new Date(), textHash: sha256(version.extractedText),
        metadata: { synthetic: true, syntheticFixture: fixture.tag, displayLabel: 'Synthetic visual review QA; persisted mock scores, no inference',
          fixtureChecksum: fixture.sourceChecksum, expectedScientificMarkers: fixture.expectedScientificMarkers, expectedReviewMarkers: fixture.expectedReviewMarkers },
        segments: { create: segments }, modelResults: { create: {
          modelName: MODEL, modelVariant: 'synthetic-fixture-v1', rawScore: fixture.globalScore, calibratedScore: fixture.globalScore,
          thresholdProfile: 'SYNTHETIC_FIXTURE', threshold: fixture.scientificThreshold, classification: 'LOW_SIGNAL', confidence: 'SYNTHETIC_PERSISTED_FIXTURE',
          calibration: 'SYNTHETIC_PERSISTED_NOT_INFERENCE', preprocessing: 'EXISTING_EXTRACTED_TEXT_UNCHANGED', inferenceMs: 0,
        } },
      }, select: { id: true } });
    }, { isolationLevel: 'Serializable' });
    const sourceAfter = await prisma.documentVersion.findUnique({ where: { id: version.id } });
    requireCondition(digest(sourceAfter) === sourceBefore, 'SYNTHETIC_SOURCE_MUTATED');
    process.stdout.write(JSON.stringify({ syntheticQa: true, syntheticFixture: fixture.tag, documentId, documentVersionId: version.id, analysisRunId: run.id,
      sourceChecksum: fixture.sourceChecksum, sourceUnchanged: true, segments: 7, scientificFlagged: 2,
      expectedReviewHighlighted: 5, expectedReviewMarkers: fixture.expectedReviewMarkers, threshold: fixture.scientificThreshold, globalScore: fixture.globalScore,
      privateDocumentUsed: false, inferenceExecuted: false, existingRunsChanged: false }) + '\n');
  } finally { await prisma.$disconnect(); }
}
main().catch(error => {
  process.stderr.write((error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : 'SYNTHETIC_VISUAL_REVIEW_QA_FAILED') + '\n');
  process.exitCode = 1;
});
