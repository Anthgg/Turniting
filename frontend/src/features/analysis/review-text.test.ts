import { describe, expect, it } from "vitest";
import { splitReviewText } from "./review-text";

const evidence = (spans: Array<{ startChar: number; endChar: number }>) => ({
  flagged: true,
  presentationExcluded: false,
  granularity: "SPAN" as const,
  paragraphFlagged: true,
  spans,
});

describe("splitReviewText", () => {
  it("falls back to the whole paragraph for paragraph evidence or unavailable spans", () => {
    expect(splitReviewText("target paragraph", {
      flagged: true,
      presentationExcluded: false,
      granularity: "PARAGRAPH",
      paragraphFlagged: true,
      spans: [],
    })).toEqual([{ text: "target paragraph", highlighted: true }]);
    expect(splitReviewText("target paragraph", evidence([])))
      .toEqual([{ text: "target paragraph", highlighted: true }]);
  });

  it("renders multiple spans in order without duplicating or changing source text", () => {
    const text = "ABCDEFGHIJKLMN";
    const parts = splitReviewText(text, evidence([
      { startChar: 8, endChar: 11 },
      { startChar: 2, endChar: 5 },
    ]));
    expect(parts).toEqual([
      { text: "AB", highlighted: false },
      { text: "CDE", highlighted: true },
      { text: "FGH", highlighted: false },
      { text: "IJK", highlighted: true },
      { text: "LMN", highlighted: false },
    ]);
    expect(parts.map((part) => part.text).join("")).toBe(text);
  });

  it("merges visual overlaps without mutating evidence", () => {
    const spans = [{ startChar: 2, endChar: 6 }, { startChar: 5, endChar: 10 }];
    const parts = splitReviewText("ABCDEFGHIJKLMN", evidence(spans));
    expect(parts).toEqual([
      { text: "AB", highlighted: false },
      { text: "CDEFGHIJ", highlighted: true },
      { text: "KLMN", highlighted: false },
    ]);
    expect(spans).toEqual([{ startChar: 2, endChar: 6 }, { startChar: 5, endChar: 10 }]);
  });

  it("uses UTF-16 offsets after an emoji and rejects an offset that splits its surrogate pair", () => {
    const text = "Autenticación 😀 biométrica";
    const startChar = text.indexOf("biométrica");
    expect(splitReviewText(text, evidence([{ startChar, endChar: text.length }]))
      .filter((part) => part.highlighted).map((part) => part.text).join("")).toBe("biométrica");
    expect(splitReviewText(text, evidence([{ startChar, endChar: text.length }]), 123)
      .filter((part) => part.highlighted).map((part) => part.text).join("")).toBe("biométrica");

    const emojiStart = text.indexOf("😀");
    expect(() => splitReviewText(text, evidence([{ startChar: emojiStart + 1, endChar: text.length }])))
      .toThrow(/invalid UTF-16 span/i);
  });

  it("does not highlight presentation-excluded evidence", () => {
    expect(splitReviewText("reference", {
      ...evidence([{ startChar: 0, endChar: 4 }]),
      presentationExcluded: true,
    })).toEqual([{ text: "reference", highlighted: false }]);
  });

  it("rejects NaN and out-of-bounds offsets", () => {
    expect(() => splitReviewText("source", evidence([{ startChar: Number.NaN, endChar: 2 }])))
      .toThrow(/invalid utf-16 span/i);
    expect(() => splitReviewText("source", evidence([{ startChar: 2, endChar: 8 }])))
      .toThrow(/invalid utf-16 span/i);
  });
});
