import { ConflictException } from '@nestjs/common';

/** Only a persisted document version can supply source bytes. Report PDFs live in a separate store. */
export interface AnalysisSourceRun {
  id: string;
  documentVersionId: string;
  sourceDocumentId: string;
  sourceDocumentVersionId: string;
  documentVersion: {
    id: string;
    documentId: string;
    originalFilename: string;
    mimeType: string;
    storageKey: string;
    fileHash: string;
    document: { id: string };
  };
}

export interface ResolvedAnalysisSource {
  readonly sourceArtifactType: 'DOCUMENT_VERSION';
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly analysisRunId: string;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly sourceChecksum: string;
  readonly sourceStorageObject: {
    readonly artifactType: 'DOCUMENT_VERSION';
    readonly storageKey: string;
  };
}

export function resolveAnalysisSource(run: AnalysisSourceRun): ResolvedAnalysisSource {
  const candidate = run as unknown as { sourceArtifactType?: string; generatedBy?: string };
  if (candidate.sourceArtifactType === 'REPORT_ARTIFACT' || candidate.generatedBy === 'TURNITING') {
    throw new ConflictException({ code: 'REPORT_ARTIFACT_CANNOT_BE_DOCUMENT_SOURCE', message: 'Un reporte no puede usarse implícitamente como fuente documental.' });
  }
  const version = run.documentVersion;
  if ((version as unknown as { sourceArtifactType?: string } | undefined)?.sourceArtifactType === 'REPORT_ARTIFACT') {
    throw new ConflictException({ code: 'REPORT_ARTIFACT_CANNOT_BE_DOCUMENT_SOURCE', message: 'Un reporte no puede usarse implícitamente como fuente documental.' });
  }
  if (
    !version || !run.sourceDocumentId || !run.sourceDocumentVersionId ||
    run.sourceDocumentVersionId !== run.documentVersionId ||
    version.id !== run.sourceDocumentVersionId ||
    version.documentId !== run.sourceDocumentId ||
    version.document.id !== run.sourceDocumentId
  ) {
    throw new ConflictException({
      code: 'ANALYSIS_SOURCE_INTEGRITY_INVALID',
      message: 'La fuente del análisis no coincide con su documento y versión guardados.',
    });
  }
  if (
    !version.originalFilename || !version.mimeType || !version.storageKey ||
    !/^[a-f0-9]{64}$/u.test(version.fileHash)
  ) {
    throw new ConflictException({
      code: 'ANALYSIS_SOURCE_METADATA_MISSING',
      message: 'La versión analizada no tiene metadatos de fuente completos.',
    });
  }
  return Object.freeze({
    sourceArtifactType: 'DOCUMENT_VERSION' as const,
    documentId: version.documentId,
    documentVersionId: version.id,
    analysisRunId: run.id,
    originalFilename: version.originalFilename,
    mimeType: version.mimeType,
    sourceChecksum: version.fileHash,
    sourceStorageObject: Object.freeze({
      artifactType: 'DOCUMENT_VERSION' as const,
      storageKey: version.storageKey,
    }),
  });
}
