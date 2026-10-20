# F009.4.2 synthetic structural presentation fixture

`createPresentationHardeningFixture()` generates an 18-page PDF and a persisted-score descriptor containing exactly 8 evaluated body segments, 20 table fragments, 10 metadata fragments, and 30 reference fragments. Three body scores meet the 0.59 threshold. One metadata segment and one reference segment retain their real synthetic scores while being excluded from visual review.

All 68 canonical segments, offsets, hashes, kinds, and structural group hints are exposed for isolated PDF tests and guarded local browser QA. These hints describe only this generated fixture. The global 0.434 score is persisted input and must never be recomputed by rendering.

Materialize temporary files with `node test/fixtures/reports/presentation-hardening/fixture.mjs <temporary-directory>` from `backend/`. No private source is included.
