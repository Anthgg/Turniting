# SPAN_SERVING_CONTRACT (F006.1.2)

Research contract for a future local integration. Nothing here is ACTIVE. Backend, frontend and the F009 PDF
are not touched in this phase.

## Input

| field | meaning |
|---|---|
| `targetText` | The paragraph being evaluated, exactly as the document stores it (string). |
| `leftContext` / `rightContext` | Optional neighbouring text. In CONTEXTUAL mode it may be shown to the model, but spans are never returned for it. |
| `mode` | `STRICT` (target only) or `CONTEXTUAL`. Offsets are relative to `targetText` in both modes. |

## Normalisation (one policy)

1. `targetText` is NFC-normalised with a character map (`nfc_with_map`). Every NFC character keeps the index of
   the original character it came from.
2. Nothing else is changed. Whitespace, line breaks, zero-width characters and homoglyphs stay in the string the
   tokenizer sees.
3. The tokenizer (mDeBERTa-v3, from the parent backbone) returns `offset_mapping` on that NFC string. Inputs are
   at most 512 tokens; longer targets are cut into paragraph-sized units first (`unit_bounds`).
4. Spans are built on NFC offsets, trimmed to visible characters (SentencePiece offsets include the leading
   space of a word), then mapped back to `targetText` through the NFC map.

## Output

```json
{
  "paragraphScore": 0.83,
  "paragraphThreshold": 0.59,
  "paragraphFlagged": true,
  "spanEvidenceAvailable": true,
  "spans": [
    {"startChar": 142, "endChar": 218, "startToken": 31, "endToken": 48, "confidence": 0.91, "label": "AI_SIGNAL"}
  ]
}
```

- `paragraphScore` / `paragraphThreshold` come from head A, calibrated by the detector's own lock. They are not
  changed to agree with the spans.
- `startChar` / `endChar` form a half-open `[start, end)` range on the ORIGINAL `targetText`, never on the
  concatenated contextual input. `startToken` / `endToken` index the model input of the target (special tokens
  included) and are for debugging.
- `confidence` is the mean token AI probability inside the span. It is used for selection, calibration and
  debugging; the UI does not have to show it.
- Multiple spans are supported. They are sorted, never overlap, and come from separate runs of positive tokens
  (gaps of at most `gap` tokens are merged).

## Post-processing (selected on VALIDATION only, frozen in `F006_1_2_MODEL_LOCK.json`)

| parameter | role |
|---|---|
| `tau` | Token AI-probability threshold. |
| `gap` | Maximum number of negative tokens bridged inside one span. |
| `min_tokens` | Minimum span length. Removes one-word highlights. |
| `abstain` (`SPAN_ABSTAIN_THRESHOLD`) | A span whose mean probability is below it is dropped. |

## No-span case and abstention

- `spans = []` and `spanEvidenceAvailable = false` when no span survives post-processing, even if
  `paragraphFlagged` is true (the NO_SPAN_EVIDENCE case). The detector never invents a highlight.
- Valid combinations are: flagged with spans, flagged without spans, and not flagged without spans. A strong span
  in a clearly negative paragraph is reported as a disagreement metric (`paragraph_span_relation`) and never
  hidden.

## Not covered

- References, metadata and boilerplate are not removed by this contract. The model is trained and evaluated to
  produce no actionable span there (REFERENCE_ONLY_SET, METADATA_ONLY_SET), and the gates require a false
  highlight rate of at most 0.02 on both.
- No equivalence with Turnitin is claimed or implied.
