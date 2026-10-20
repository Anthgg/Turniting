import { describe, expect, it } from 'vitest';
import { resolveAnalysisSource, type AnalysisSourceRun } from './analysis-source.js';

function run(): AnalysisSourceRun {
  return { id: 'run', documentVersionId: 'version', sourceDocumentId: 'document', sourceDocumentVersionId: 'version', documentVersion: { id: 'version', documentId: 'document', originalFilename: 'thesis-fixture.pdf', mimeType: 'application/pdf', storageKey: 'uploads/synthetic.pdf', fileHash: 'a'.repeat(64), document: { id: 'document' } } };
}

describe('resolveAnalysisSource', () => {
  it('returns an immutable source exclusively from the exact persisted run version', () => {
    const source = resolveAnalysisSource(run());
    expect(source).toMatchObject({ sourceArtifactType: 'DOCUMENT_VERSION', documentId: 'document', documentVersionId: 'version', analysisRunId: 'run', originalFilename: 'thesis-fixture.pdf', sourceStorageObject: { artifactType: 'DOCUMENT_VERSION', storageKey: 'uploads/synthetic.pdf' } });
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.sourceStorageObject)).toBe(true);
  });
  it.each(['sourceDocumentId', 'sourceDocumentVersionId', 'documentVersionId'] as const)('rejects inconsistent %s without selecting a fallback', field => {
    const value = run(); value[field] = 'other';
    expect(() => resolveAnalysisSource(value)).toThrowError(expect.objectContaining({ response: expect.objectContaining({ code: 'ANALYSIS_SOURCE_INTEGRITY_INVALID' }) }));
  });
  it('rejects ReportArtifact objects explicitly', () => {
    expect(() => resolveAnalysisSource({ ...run(), generatedBy: 'TURNITING', sourceArtifactType: 'REPORT_ARTIFACT' } as AnalysisSourceRun)).toThrowError(expect.objectContaining({ response: expect.objectContaining({ code: 'REPORT_ARTIFACT_CANNOT_BE_DOCUMENT_SOURCE' }) }));
  });
  it('allows an explicitly uploaded report PDF as its own genuine DocumentVersion', () => {
    const value = run(); value.documentVersion.originalFilename = 'turniting_paragraph-technical_manual-upload.pdf';
    expect(resolveAnalysisSource(value).originalFilename).toBe(value.documentVersion.originalFilename);
  });
});
