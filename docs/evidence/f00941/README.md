# F009.4.1 downloaded synthetic PDF inspection

The PNGs and `ui-download-pdf-inspection.json` inspect the actual PDFs downloaded through the browser. The original review preserves all 18 source page content streams after its cover, uses the same run and source version as the technical report, and displays the persisted 43.4% global score and 59.0% threshold.

The actual browser run has four highlighted body paragraphs and five highlighted paragraphs in total. Warning `REFERENCE_INLINE_HEADING_NOT_CLASSIFIED` records that its inline `References:` citation is not recognized as a reference section by the existing presentation classifier, so that scored citation is also highlighted. The metadata paragraph is excluded correctly. This evidence and the persisted fixture are preserved; no classifier or score was changed.

The renderer regression supplies an explicit `REFERENCE_SECTION` exclusion and verifies that an excluded reference does not highlight. That isolated renderer input differs from the existing classifier's result for the browser fixture. Technical reporting preserves all 12 segments, their local scores, and the two `NO EVALUADO` states.
