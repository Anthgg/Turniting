import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createPresentationHardeningFixture, sha256 } from '../test/fixtures/reports/presentation-hardening/fixture.mjs';
import { createReviewDocumentContext, getReviewEvidence, getReviewPresentation, normalizeReviewSegmentOffsets } from '../dist/analysis/review-presentation.js';
import { buildTechnicalDisplayUnits } from '../dist/reports/technical-display.js';

const TAG = 'F00942_SYNTHETIC_BROWSER_QA';
const MODEL = 'SYNTHETIC_F00942_PERSISTED_SCORES';
function requireCondition(value, code) { if (!value) throw new Error(code); }
function escaped(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }

async function main() {
  const documentId = process.argv[2];
  requireCondition(process.argv.length === 3 && /^[0-9a-f-]{36}$/iu.test(documentId ?? ''), 'EXACT_SYNTHETIC_DOCUMENT_ID_REQUIRED');
  const databaseUrl = process.env.DATABASE_URL;
  requireCondition(databaseUrl && ['db', 'postgres', 'database', 'localhost', '127.0.0.1', '[::1]', '::1', 'host.docker.internal'].includes(new URL(databaseUrl).hostname.toLowerCase()), 'LOCAL_DATABASE_REQUIRED');
  const fixture = await createPresentationHardeningFixture();
  const prisma = new PrismaClient();
  try {
    const document = await prisma.document.findUnique({ where: { id: documentId }, include: { currentVersion: { include: { analysisRuns: true } } } });
    const version = document?.currentVersion;
    requireCondition(document && version && version.documentId === documentId, 'SYNTHETIC_SOURCE_REQUIRED');
    requireCondition(document.originalName === fixture.input.document.filename && version.originalFilename === fixture.input.document.filename && version.mimeType === 'application/pdf' && document.mimeType === 'application/pdf', 'EXACT_SYNTHETIC_FILENAME_AND_TYPE_REQUIRED');
    requireCondition(version.fileHash === fixture.input.document.sourceChecksum && version.ingestionOrigin === 'USER_UPLOAD' && version.pageCount === 18 && !version.requiresOcr && typeof version.extractedText === 'string', 'EXACT_SYNTHETIC_SOURCE_CHECKSUM_REQUIRED');
    requireCondition(!version.analysisRuns.some(run => run.metadata?.syntheticFixture === TAG), 'SYNTHETIC_RUN_ALREADY_EXISTS');
    requireCondition(process.env.UPLOAD_DIR && /^[0-9a-f-]{36}\.pdf$/iu.test(version.storageKey), 'UPLOAD_SOURCE_REQUIRED');
    const root = await realpath(process.env.UPLOAD_DIR);
    const target = path.resolve(root, version.storageKey);
    const stats = await lstat(target);
    const actual = await realpath(target);
    const relative = path.relative(root, actual);
    requireCondition(stats.isFile() && !stats.isSymbolicLink() && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'UPLOAD_SOURCE_OUTSIDE_ROOT');
    requireCondition(sha256(await readFile(actual)) === fixture.input.document.sourceChecksum, 'UPLOAD_BYTES_MISMATCH');
    let cursor = 0;
    const hints = {};
    const segments = fixture.input.paragraphs.map(paragraph => {
      const match = new RegExp(paragraph.textPreview.split(/\s+/u).map(escaped).join('\\s+'), 'u').exec(version.extractedText.slice(cursor));
      requireCondition(match, 'CANONICAL_SYNTHETIC_TEXT_NOT_FOUND');
      const charStart = cursor + match.index;
      const charEnd = charStart + match[0].length;
      cursor = charEnd;
      const textHash = sha256(match[0].replace(/\s+/gu, ' ').trim());
      hints[paragraph.paragraphIndex] = { ...fixture.presentationStructureHints[paragraph.paragraphIndex], charStart, charEnd, textHash };
      return { paragraphIndex: paragraph.paragraphIndex, charStart, charEnd, textHash,
        pageNumber: paragraph.pageNumber, words: paragraph.words, tokens: paragraph.tokens,
        rawScore: paragraph.score, calibratedScore: paragraph.score, classification: paragraph.classification,
        signalLevel: paragraph.signalLevel, confidence: 'SYNTHETIC_PERSISTED_FIXTURE', modelName: MODEL };
    });
    const verified = normalizeReviewSegmentOffsets(version.extractedText, segments);
    requireCondition(verified.every((segment, index) => segment.charStart === segments[index].charStart && segment.charEnd === segments[index].charEnd), 'SYNTHETIC_OFFSETS_CHANGED');
    const contextSegments = verified.map(segment => ({ ...segment, ...hints[segment.paragraphIndex] }));
    const context = createReviewDocumentContext(version.extractedText, contextSegments);
    const presentation = buildTechnicalDisplayUnits(verified.map((segment, index) => ({
      ...fixture.input.paragraphs[index], ...segment, ...hints[segment.paragraphIndex],
      textPreview: version.extractedText.slice(segment.charStart, segment.charEnd),
      reviewEvidence: getReviewEvidence(segment, .59, context),
      reviewPresentation: getReviewPresentation(segment, context, .59),
    })), { extractedText: version.extractedText, threshold: .59 });
    requireCondition(presentation.counts.totalSegments === 68 && presentation.counts.evaluated === 10 && presentation.counts.rawFlaggedCount === 5 && presentation.counts.presentationExcludedFlagged === 2 && presentation.counts.actionableHighlightCount === 3 && presentation.audit.sourceSegmentsLost === 0 && presentation.audit.sourceSegmentsDuplicated === 0, 'SYNTHETIC_PRESENTATION_VALIDATION_FAILED');
    const run = await prisma.$transaction(async transaction => {
      const fresh = await transaction.documentVersion.findUnique({ where: { id: version.id } });
      requireCondition(fresh && fresh.fileHash === version.fileHash && fresh.extractedText === version.extractedText && fresh.ingestionOrigin === 'USER_UPLOAD', 'SYNTHETIC_SOURCE_CHANGED');
      requireCondition(!await transaction.analysisRun.findFirst({ where: { documentVersionId: version.id, metadata: { path: ['syntheticFixture'], equals: TAG } } }), 'SYNTHETIC_RUN_ALREADY_EXISTS');
      return transaction.analysisRun.create({ data: {
        documentVersionId: version.id, sourceDocumentId: documentId, sourceDocumentVersionId: version.id,
        status: 'COMPLETED', analyzerMode: 'ENSEMBLE', analyzerVersion: TAG, thresholdProfile: 'SYNTHETIC_FIXTURE',
        threshold: .59, granularity: 'PARAGRAPH', paragraphMode: 'STRICT_PARAGRAPH', documentAggregation: 'SYNTHETIC_PERSISTED_SCORE',
        documentScore: .434, documentClassification: 'LOW_SIGNAL', signalLevel: 'MODERATE', scoredSegments: 10,
        insufficientSegments: 58, inferenceMs: 0, completedAt: new Date(), textHash: sha256(version.extractedText),
        metadata: { synthetic: true, syntheticFixture: TAG, displayLabel: 'Synthetic presentation QA; persisted mock scores, no inference',
          fixtureChecksum: version.fileHash, presentationStructureHints: hints },
        segments: { create: segments }, modelResults: { create: {
          modelName: MODEL, modelVariant: 'synthetic-fixture-v1', rawScore: .434, calibratedScore: .434,
          thresholdProfile: 'SYNTHETIC_FIXTURE', threshold: .59, classification: 'LOW_SIGNAL', confidence: 'SYNTHETIC_PERSISTED_FIXTURE',
          calibration: 'SYNTHETIC_PERSISTED_NOT_INFERENCE', preprocessing: 'EXISTING_EXTRACTED_TEXT_UNCHANGED', inferenceMs: 0,
        } },
      }, select: { id: true } });
    }, { isolationLevel: 'Serializable' });
    process.stdout.write(JSON.stringify({ syntheticQa: true, documentId, documentVersionId: version.id, analysisRunId: run.id,
      sourceChecksum: version.fileHash, ...presentation.counts, ...presentation.audit }) + '\n');
  } finally { await prisma.$disconnect(); }
}
main().catch(error => {
  process.stderr.write((error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : 'SYNTHETIC_PRESENTATION_QA_FAILED') + '\n');
  process.exitCode = 1;
});
