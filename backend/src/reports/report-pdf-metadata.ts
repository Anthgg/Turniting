import { PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';

export interface TurnitingReportMarker {
  reportId: string;
  reportVariant: 'AI_ORIGINAL_REVIEW' | 'AI_PARAGRAPH_TECHNICAL';
  analysisRunId: string;
  sourceDocumentId: string;
  sourceDocumentVersionId: string;
  rendererVersion: string;
}

/** Complementary PDF provenance. The persisted report/source relations are authoritative. */
export async function stampTurnitingReport(
  buffer: Buffer,
  marker: TurnitingReportMarker,
): Promise<Buffer> {
  const document = await PDFDocument.load(buffer, { updateMetadata: false });
  document.setProducer('TURNITING');
  document.setCreator('TURNITING');
  // setProducer creates Info when absent; custom entries remain available to PDF tools.
  const info = document.context.lookup(document.context.trailerInfo.Info);
  if (info instanceof PDFDict) {
    for (const [name, value] of Object.entries({ generatedBy: 'TURNITING', ...marker })) {
      info.set(PDFName.of(`turniting.${name}`), PDFString.of(value));
    }
  }
  return Buffer.from(await document.save({ useObjectStreams: true }));
}
