import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }));
vi.mock("./client", () => client);
import { getAnalysisTechnicalPresentation, technicalPresentationSchema, segmentListSchema } from "./analysis";

const RUN_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

describe("technical presentation API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the exact persisted run using GET without starting analysis", () => {
    getAnalysisTechnicalPresentation(RUN_ID);
    expect(client.getJson).toHaveBeenCalledWith(`/analyses/${RUN_ID}/technical-presentation`, technicalPresentationSchema);
    expect(client.postJson).not.toHaveBeenCalled();
  });

  it("retains exact evaluated percentages, authoritative counts and source membership", () => {
    const input = {
      analysisRunId: RUN_ID,
      reviewHighlightThreshold: 20 / 100, reviewHighlightComparator: "GT", presentationPolicyVersion: "f00943-review-gt20-v1",
      counts: { totalSegments: 3, evaluatedSegments: 1, insufficientSegments: 2, rawFlaggedCount: 1, scientificFlaggedCount: 1, presentationExcludedFlagged: 1, actionableHighlightCount: 0, reviewHighlightedCount: 0, structuralGroups: 1 },
      actionableParagraphIndices: [],
      displayUnits: [{ id: "references", type: "REFERENCE_GROUP", label: "REFERENCIAS", sourceSegmentIds: [0, 1, 2], paragraphIndices: [0, 1, 2], positionStart: 0, positionEnd: 100, text: "References: Smith et al.\n[2] Synthetic text.", presentationExcluded: true, excludedReason: "REFERENCE_SECTION", evaluatedSegments: [{ sourceSegmentId: 1, paragraphIndex: 1, score: 0.83241, threshold: 0.59, flagged: true, presentationExcluded: true, excludedReason: "REFERENCE_SECTION", text: "Smith et al." }] }],
      audit: { segmentsLost: 0, segmentsDuplicated: 0 },
    };
    const parsed = technicalPresentationSchema.parse(input);
    expect(parsed.displayUnits[0].evaluatedSegments[0].score).toBe(0.83241);
    expect(parsed.displayUnits[0].evaluatedSegments[0].threshold).toBe(0.59);
    expect(parsed.counts).toEqual(input.counts);
    expect(parsed.displayUnits[0].sourceSegmentIds).toEqual([0, 1, 2]);
    expect(parsed.audit).toEqual(input.audit);
    expect(parsed.reviewHighlightThreshold).toBe(input.reviewHighlightThreshold);
    expect(parsed.reviewHighlightComparator).toBe("GT");
    expect(parsed.presentationPolicyVersion).toBe("f00943-review-gt20-v1");
    expect(parsed.displayUnits[0]).not.toHaveProperty("score");
  });

  it("accepts additive segment policy metadata and legacy responses without inventing a threshold", () => {
    const legacy = { analysisId: RUN_ID, stale: false, items: [] };
    expect(segmentListSchema.parse(legacy)).not.toHaveProperty("reviewHighlightThreshold");
    const current = { ...legacy, reviewHighlightThreshold: 20 / 100, reviewHighlightComparator: "GT",
      presentationPolicyVersion: "f00943-review-gt20-v1", reviewHighlightedCount: 5, scientificFlaggedCount: 2 };
    expect(segmentListSchema.parse(current)).toEqual(current);
  });
});
