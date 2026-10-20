# F009.4.1 source integrity fixture

`fixture.mjs` generates `thesis-fixture.pdf`, an 18-page original PDF, and a persisted synthetic run descriptor. It contains eight long evaluable body paragraphs, two insufficient paragraphs, one metadata paragraph, and one reference paragraph. Four body scores meet the persisted threshold of 0.59. The global score remains the explicitly persisted 0.434; report generation must never recompute it.

Run `node test/fixtures/reports/source-integrity/fixture.mjs <temporary-directory>` from `backend/` to materialize the fixture for local browser QA. Generated files are temporary QA data and should not be committed.

All text and identifiers are generated sample material. No private document is used.
