export interface ReviewTextSpan {
  startChar: number;
  endChar: number;
}

export interface ReviewTextEvidence {
  flagged: boolean;
  reviewHighlighted?: boolean;
  presentationExcluded: boolean;
  granularity: "PARAGRAPH" | "SPAN";
  paragraphFlagged: boolean;
  spans: readonly ReviewTextSpan[];
}

export interface ReviewTextPart {
  text: string;
  highlighted: boolean;
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

/** Split exact source text into normal/highlighted parts using UTF-16 offsets. */
export function splitReviewText(
  text: string,
  evidence?: ReviewTextEvidence,
  paragraphCharStart = 0,
): ReviewTextPart[] {
  if (!evidence || evidence.reviewHighlighted !== true || evidence.presentationExcluded) {
    return [{ text, highlighted: false }];
  }

  if (!Number.isSafeInteger(paragraphCharStart) || paragraphCharStart < 0) {
    throw new RangeError("Review paragraph offset is invalid.");
  }
  const documentSpans = evidence.granularity === "SPAN"
    ? evidence.spans.map((span) => ({
      // Evidence is paragraph-relative; rendering ranges are document-relative.
      startChar: paragraphCharStart + span.startChar,
      endChar: paragraphCharStart + span.endChar,
    }))
    : [];
  if (documentSpans.some((span) =>
    !Number.isSafeInteger(span.startChar) || !Number.isSafeInteger(span.endChar),
  )) {
    throw new RangeError("Review evidence contains an invalid UTF-16 span.");
  }
  const usableSpans = documentSpans.map((span) => ({
    startChar: span.startChar - paragraphCharStart,
    endChar: span.endChar - paragraphCharStart,
  }));
  if (usableSpans.some((span) =>
    !Number.isSafeInteger(span.startChar) ||
    !Number.isSafeInteger(span.endChar) ||
    span.startChar < 0 ||
    span.endChar <= span.startChar ||
    span.endChar > text.length ||
    splitsSurrogatePair(text, span.startChar) ||
    splitsSurrogatePair(text, span.endChar),
  )) {
    throw new RangeError("Review evidence contains an invalid UTF-16 span.");
  }

  const ranges = usableSpans.length > 0
    ? usableSpans
    : [{ startChar: 0, endChar: text.length }];
  const ordered = [...ranges]
    .map((span) => ({ ...span }))
    .sort((left, right) => left.startChar - right.startChar || left.endChar - right.endChar);
  const merged: ReviewTextSpan[] = [];
  for (const span of ordered) {
    const previous = merged.at(-1);
    if (previous && span.startChar < previous.endChar) {
      previous.endChar = Math.max(previous.endChar, span.endChar);
    } else {
      merged.push(span);
    }
  }
  if (!merged.length) return [{ text, highlighted: false }];

  const parts: ReviewTextPart[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.startChar > cursor) {
      parts.push({ text: text.slice(cursor, range.startChar), highlighted: false });
    }
    parts.push({ text: text.slice(range.startChar, range.endChar), highlighted: true });
    cursor = range.endChar;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), highlighted: false });
  return parts.length ? parts : [{ text, highlighted: false }];
}
