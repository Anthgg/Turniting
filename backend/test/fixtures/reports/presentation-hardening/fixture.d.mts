import type { AIReportInput } from '../../../../src/reports/report.contracts.js';
export const FIXTURE_IDS: { documentId: string; documentVersionId: string; analysisRunId: string; technicalReportId: string; originalReportId: string };
export function sha256(value: string | Buffer): string;
export function createPresentationHardeningFixture(): Promise<{
  source: Buffer; input: AIReportInput; bodyScores: number[];
  presentationStructureHints: Record<string, { kind: string; structuralType?: string; structuralGroupId?: string }>;
  expectedSourcePages: number; expectedOriginalReviewPages: number; expectedBodyFlagged: number; expectedRawFlagged: number; expectedPresentationExcludedFlagged: number;
}>;
