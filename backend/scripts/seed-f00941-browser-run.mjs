import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createSourceIntegrityFixture, sha256 } from '../test/fixtures/reports/source-integrity/fixture.mjs';
import { createReviewDocumentContext, getReviewEvidence, normalizeReviewSegmentOffsets } from '../dist/analysis/review-presentation.js';

const FIXTURE_TAG = 'F0094_1_SOURCE_INTEGRITY_BROWSER_QA';
const MODEL_NAME = 'SYNTHETIC_F00941_BROWSER_QA_PERSISTED_SCORES';
const REPAIR_DOCUMENT_ID = '05a7a293-15e8-495f-bb78-1d444b7c0e61';
const REPAIR_RUN_ID = '5d214d15-8997-435d-87d5-f15556205a2d';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function mapCanonicalSegments(extractedText, fixture) {
  let cursor = 0;
  return fixture.input.paragraphs.map((paragraph) => {
    const pattern = paragraph.textPreview.split(/\s+/u).map(escapeRegex).join('\\s+');
    const match = new RegExp(pattern, 'u').exec(extractedText.slice(cursor));
    requireCondition(match, 'SYNTHETIC_FIXTURE_CANONICAL_SEGMENT_NOT_FOUND');
    const charStart = cursor + match.index;
    const charEnd = charStart + match[0].length;
    cursor = charEnd;
    return {
      paragraphIndex: paragraph.paragraphIndex,
      charStart,
      charEnd,
      textHash: sha256(extractedText.slice(charStart, charEnd).replace(/\s+/gu, ' ').trim()),
      pageNumber: paragraph.pageNumber,
      words: paragraph.words,
      tokens: paragraph.tokens,
      rawScore: paragraph.score,
      calibratedScore: paragraph.score,
      classification: paragraph.score === null ? 'INSUFFICIENT_TEXT' : paragraph.score >= fixture.input.run.threshold ? 'MACHINE_SIGNAL' : 'LOW_SIGNAL',
      signalLevel: paragraph.signalLevel,
      confidence: 'SYNTHETIC_PERSISTED_FIXTURE',
      modelName: MODEL_NAME,
    };
  });
}

function validateMappedSegments(extractedText, segments) {
  const normalized = normalizeReviewSegmentOffsets(extractedText, segments);
  const context = createReviewDocumentContext(extractedText, normalized);
  requireCondition(context.segments.length === 12 && normalized.every((segment, index) => segment.charStart === segments[index].charStart && segment.charEnd === segments[index].charEnd), 'SYNTHETIC_QA_REVIEW_INTEGRITY_VALIDATION_FAILED');
  return normalized;
}

function presentationCounts(extractedText, segments, threshold) {
  const context = createReviewDocumentContext(extractedText, segments);
  const evidence = segments.map((segment) => ({ paragraphIndex: segment.paragraphIndex, ...getReviewEvidence(segment, threshold, context) }));
  return {
    actualBodyFlagged: evidence.filter((item) => item.paragraphIndex >= 1 && item.paragraphIndex <= 8 && item.flagged && !item.presentationExcluded).length,
    actualPresentationFlagged: evidence.filter((item) => item.flagged && !item.presentationExcluded).length,
    thresholdFlagged: evidence.filter((item) => item.flagged).length,
    classificationWarnings: evidence.find((item) => item.paragraphIndex === 11)?.excludedReason !== 'REFERENCE_SECTION' ? ['REFERENCE_INLINE_HEADING_NOT_CLASSIFIED'] : [],
  };
}

async function repairOwnFixtureSegmentHashes(prisma, documentId, version, fixture, expectedSegments, runId) {
  requireCondition(documentId === REPAIR_DOCUMENT_ID && runId === REPAIR_RUN_ID, 'REPAIR_EXACT_SYNTHETIC_DOCUMENT_AND_RUN_REQUIRED');
  return prisma.$transaction(async (transaction) => {
    const fresh = await transaction.documentVersion.findUnique({ where: { id: version.id } });
    requireCondition(fresh && fresh.documentId === documentId && fresh.ingestionOrigin === 'USER_UPLOAD' && fresh.fileHash === fixture.input.document.sourceChecksum && fresh.extractedText === version.extractedText, 'SYNTHETIC_FIXTURE_SOURCE_CHANGED_DURING_QA');
    requireCondition(await transaction.reportArtifact.count({ where: { analysisRunId: runId } }) === 0, 'REPAIR_REQUIRES_ZERO_REPORT_ARTIFACTS');
    const run = await transaction.analysisRun.findUnique({ where: { id: runId }, include: { segments: { orderBy: { paragraphIndex: 'asc' } }, modelResults: true } });
    requireCondition(run && run.documentVersionId === version.id && run.sourceDocumentId === documentId && run.sourceDocumentVersionId === version.id && run.status === 'COMPLETED', 'REPAIR_EXACT_SYNTHETIC_RUN_SOURCE_REQUIRED');
    requireCondition(run.metadata?.synthetic === true && run.metadata?.syntheticFixture === FIXTURE_TAG && run.metadata?.fixtureChecksum === fixture.input.document.sourceChecksum, 'REPAIR_OWN_SYNTHETIC_FIXTURE_MARKER_REQUIRED');
    requireCondition(run.documentScore === 0.434 && run.threshold === 0.59 && run.scoredSegments === 10 && run.insufficientSegments === 2 && run.analyzerMode === 'ENSEMBLE' && run.analyzerVersion === 'F00941_SYNTHETIC_BROWSER_QA_PERSISTED_SCORES' && run.thresholdProfile === 'SYNTHETIC_FIXTURE' && run.documentAggregation === 'SYNTHETIC_PERSISTED_SCORE', 'REPAIR_SYNTHETIC_RUN_VALUES_MISMATCH');
    requireCondition(run.modelResults.length === 1 && run.modelResults[0].modelName === MODEL_NAME && run.modelResults[0].calibration === 'SYNTHETIC_PERSISTED_NOT_MODEL_INFERENCE' && run.modelResults[0].calibratedScore === 0.434 && run.modelResults[0].rawScore === 0.434 && run.modelResults[0].threshold === 0.59 && run.modelResults[0].thresholdProfile === 'SYNTHETIC_FIXTURE', 'REPAIR_SYNTHETIC_MODEL_VALUES_MISMATCH');
    requireCondition(run.segments.length === expectedSegments.length, 'REPAIR_SYNTHETIC_SEGMENT_COUNT_MISMATCH');
    const fields = ['paragraphIndex', 'charStart', 'charEnd', 'pageNumber', 'words', 'tokens', 'rawScore', 'calibratedScore', 'classification', 'signalLevel', 'confidence', 'modelName'];
    for (let index = 0; index < run.segments.length; index += 1) {
      const persisted = run.segments[index];
      const expected = expectedSegments[index];
      requireCondition(fields.every((field) => persisted[field] === expected[field]), 'REPAIR_SYNTHETIC_SEGMENT_VALUES_MISMATCH');
      const oldRawHash = sha256(version.extractedText.slice(expected.charStart, expected.charEnd));
      requireCondition(persisted.textHash === oldRawHash || persisted.textHash === expected.textHash, 'REPAIR_UNEXPECTED_SEGMENT_HASH');
    }
    let repairedHashes = 0;
    for (let index = 0; index < run.segments.length; index += 1) {
      const persisted = run.segments[index];
      const expected = expectedSegments[index];
      if (persisted.textHash === expected.textHash) continue;
      const updated = await transaction.analysisSegment.updateMany({ where: { id: persisted.id, analysisRunId: runId, textHash: persisted.textHash }, data: { textHash: expected.textHash } });
      requireCondition(updated.count === 1, 'REPAIR_SYNTHETIC_SEGMENT_CHANGED_DURING_QA');
      repairedHashes += 1;
    }
    const repaired = await transaction.analysisSegment.findMany({ where: { analysisRunId: runId }, orderBy: { paragraphIndex: 'asc' } });
    validateMappedSegments(version.extractedText, repaired);
    return { syntheticQaRepair: true, documentId, documentVersionId: version.id, analysisRunId: runId, segments: repaired.length, repairedHashes, score: run.documentScore, threshold: run.threshold, scoresPreserved: true, modelsPreserved: true, reportArtifacts: 0, expectedBodyFlagged: 4, ...presentationCounts(version.extractedText, repaired, run.threshold) };
  }, { isolationLevel: 'Serializable' });
}

async function assertExactSourceBytes(version, expectedHash) {
  const configuredRoot = process.env.UPLOAD_DIR;
  requireCondition(configuredRoot, 'UPLOAD_DIR_REQUIRED_FOR_SYNTHETIC_SOURCE_CHECK');
  requireCondition(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/iu.test(version.storageKey), 'SYNTHETIC_SOURCE_STORAGE_KEY_INVALID');
  const root = await realpath(path.resolve(configuredRoot));
  const target = path.resolve(root, version.storageKey);
  const stats = await lstat(target);
  requireCondition(stats.isFile() && !stats.isSymbolicLink(), 'SYNTHETIC_SOURCE_NOT_REGULAR_FILE');
  const actual = await realpath(target);
  const relative = path.relative(root, actual);
  requireCondition(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'SYNTHETIC_SOURCE_OUTSIDE_UPLOAD_ROOT');
  requireCondition(sha256(await readFile(actual)) === expectedHash, 'SYNTHETIC_SOURCE_BYTES_MISMATCH');
}

/** Creates only a new labelled QA run for the exact generated fixture. No inference or document mutation. */
async function main() {
  const documentId = process.argv[2];
  const repairMode = process.argv[3] === '--repair-segment-hashes';
  const repairRunId = process.argv[4];
  requireCondition(uuidPattern.test(documentId ?? ''), 'EXACT_DOCUMENT_ID_REQUIRED');
  requireCondition(process.argv.length <= (repairMode ? 5 : 3), 'UNEXPECTED_SYNTHETIC_QA_ARGUMENTS');
  if (repairMode) requireCondition(documentId === REPAIR_DOCUMENT_ID && repairRunId === REPAIR_RUN_ID, 'REPAIR_EXACT_SYNTHETIC_DOCUMENT_AND_RUN_REQUIRED');
  const databaseUrl = process.env.DATABASE_URL;
  requireCondition(databaseUrl, 'DATABASE_URL_REQUIRED');
  const databaseHost = new URL(databaseUrl).hostname.toLowerCase();
  requireCondition(['db', 'postgres', 'database', 'localhost', '127.0.0.1', '[::1]', '::1', 'host.docker.internal'].includes(databaseHost), 'SYNTHETIC_QA_REQUIRES_LOCAL_DATABASE');
  const fixture = await createSourceIntegrityFixture();
  const prisma = new PrismaClient();
  try {
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      include: { currentVersion: { include: { analysisRuns: { select: { id: true, status: true, metadata: true } } } } },
    });
    const version = document?.currentVersion;
    requireCondition(document && version && version.documentId === documentId, 'SYNTHETIC_FIXTURE_DOCUMENT_VERSION_REQUIRED');
    requireCondition(document.originalName === 'thesis-fixture.pdf' && version.originalFilename === 'thesis-fixture.pdf', 'SYNTHETIC_FIXTURE_FILENAME_REQUIRED');
    requireCondition(document.mimeType === 'application/pdf' && version.mimeType === 'application/pdf', 'SYNTHETIC_FIXTURE_PDF_REQUIRED');
    requireCondition(document.status === 'EXTRACTED' && typeof version.extractedText === 'string' && version.extractedText.length > 0, 'SYNTHETIC_FIXTURE_EXTRACTION_REQUIRED');
    requireCondition(version.ingestionOrigin === 'USER_UPLOAD', 'SYNTHETIC_FIXTURE_EXPLICIT_USER_UPLOAD_REQUIRED');
    requireCondition(version.fileHash === fixture.input.document.sourceChecksum, 'SYNTHETIC_FIXTURE_CHECKSUM_REQUIRED');
    requireCondition(version.pageCount === 18 && !version.requiresOcr, 'SYNTHETIC_FIXTURE_EXPECTED_DIGITAL_PAGES_REQUIRED');
    requireCondition(version.analysisRuns.some((run) => run.metadata?.syntheticFixture !== FIXTURE_TAG), 'BROWSER_ANALYZE_STEP_REQUIRED_BEFORE_SYNTHETIC_RUN');
    await assertExactSourceBytes(version, fixture.input.document.sourceChecksum);
    const segments = validateMappedSegments(version.extractedText, mapCanonicalSegments(version.extractedText, fixture));
    requireCondition(segments.length === 12 && segments.filter((item) => item.calibratedScore === null).length === 2, 'SYNTHETIC_FIXTURE_SEGMENT_COUNT_INVALID');
    if (repairMode) {
      const result = await repairOwnFixtureSegmentHashes(prisma, documentId, version, fixture, segments, repairRunId);
      process.stdout.write(JSON.stringify(result) + '\n');
      return;
    }
    requireCondition(!version.analysisRuns.some((run) => run.metadata?.syntheticFixture === FIXTURE_TAG), 'SYNTHETIC_QA_RUN_ALREADY_EXISTS');
    const now = new Date();
    const created = await prisma.$transaction(async (transaction) => {
      const fresh = await transaction.documentVersion.findUnique({ where: { id: version.id } });
      requireCondition(fresh && fresh.documentId === documentId && fresh.ingestionOrigin === 'USER_UPLOAD' && fresh.fileHash === version.fileHash && fresh.extractedText === version.extractedText, 'SYNTHETIC_FIXTURE_SOURCE_CHANGED_DURING_QA');
      requireCondition(!(await transaction.analysisRun.findFirst({ where: { documentVersionId: version.id, metadata: { path: ['syntheticFixture'], equals: FIXTURE_TAG } }, select: { id: true } })), 'SYNTHETIC_QA_RUN_ALREADY_EXISTS');
      return transaction.analysisRun.create({
        data: {
          documentVersionId: version.id,
          sourceDocumentId: documentId,
          sourceDocumentVersionId: version.id,
          status: 'COMPLETED',
          analyzerMode: 'ENSEMBLE',
          analyzerVersion: 'F00941_SYNTHETIC_BROWSER_QA_PERSISTED_SCORES',
          thresholdProfile: 'SYNTHETIC_FIXTURE',
          threshold: fixture.input.run.threshold,
          granularity: 'PARAGRAPH',
          paragraphMode: 'STRICT_PARAGRAPH',
          documentAggregation: 'SYNTHETIC_PERSISTED_SCORE',
          documentScore: fixture.input.run.documentScore,
          documentClassification: 'LOW_SIGNAL',
          signalLevel: 'MODERATE',
          scoredSegments: 10,
          insufficientSegments: 2,
          inferenceMs: 0,
          textHash: sha256(version.extractedText),
          metadata: {
            synthetic: true,
            syntheticFixture: FIXTURE_TAG,
            displayLabel: 'SYNTHETIC FIXTURE QA - persisted mock scores, no inference',
            fixtureChecksum: fixture.input.document.sourceChecksum,
            purpose: 'F009.4.1 dual report browser smoke',
            originalInferenceRunIdsPreserved: version.analysisRuns.map((run) => run.id),
            expectedBodyFlagged: 4,
            sourceDocumentId: documentId,
            sourceDocumentVersionId: version.id,
          },
          createdAt: now,
          completedAt: now,
          segments: { create: segments },
          modelResults: { create: {
            modelName: MODEL_NAME,
            modelVariant: 'SYNTHETIC_FIXTURE_ONLY',
            rawScore: fixture.input.run.documentScore,
            calibratedScore: fixture.input.run.documentScore,
            thresholdProfile: 'SYNTHETIC_FIXTURE',
            threshold: fixture.input.run.threshold,
            classification: 'LOW_SIGNAL',
            confidence: 'SYNTHETIC_PERSISTED_FIXTURE',
            calibration: 'SYNTHETIC_PERSISTED_NOT_MODEL_INFERENCE',
            preprocessing: 'EXISTING_EXTRACTED_TEXT_UNCHANGED',
            inferenceMs: 0,
          } },
        },
        select: { id: true, sourceDocumentId: true, sourceDocumentVersionId: true, documentScore: true, threshold: true, scoredSegments: true, insufficientSegments: true },
      });
    }, { isolationLevel: 'Serializable' });
    process.stdout.write(JSON.stringify({ syntheticQa: true, analysisRunId: created.id, documentId: created.sourceDocumentId, documentVersionId: created.sourceDocumentVersionId, segments: segments.length, bodyEvaluable: 8, insufficient: created.insufficientSegments, metadata: 1, reference: 1, expectedBodyFlagged: 4, ...presentationCounts(version.extractedText, segments, created.threshold), score: created.documentScore, threshold: created.threshold, originalInferenceRunCountPreserved: version.analysisRuns.length }) + '\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  const code = error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)
    ? error.message : 'SYNTHETIC_QA_SEED_FAILED';
  process.stderr.write(code + '\n');
  process.exitCode = 1;
});
