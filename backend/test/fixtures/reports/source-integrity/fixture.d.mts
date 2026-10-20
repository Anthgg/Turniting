import type { AIReportInput } from '../../../../src/reports/report.contracts.js';

export const FIXTURE_IDS: {
  documentId: string;
  documentVersionId: string;
  analysisRunId: string;
  technicalReportId: string;
  originalReportId: string;
};
export function sha256(value: string | Buffer): string;
export function createSourceIntegrityFixture(): Promise<{
  source: Buffer;
  input: AIReportInput;
  bodyScores: number[];
  expectedSourcePages: number;
  expectedOriginalReviewPages: number;
  expectedActionableFlagged: number;
}>;
