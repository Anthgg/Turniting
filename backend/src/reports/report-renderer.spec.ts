import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ReportRenderer } from './report-renderer.js';
import type {
  AIReportInput,
  SimilarityReportInput,
} from './report.contracts.js';

const renderer = new ReportRenderer();
const reportId = 'f41df3b7-70e7-40a1-8dbb-5d011be30d37';

function pageCount(pdf: Buffer): number {
  return [...pdf.toString('latin1').matchAll(/\/Type\s*\/Page\b/g)].length;
}

function pdfText(pdf: Buffer): string {
  const source = pdf.toString('latin1');
  const textParts: string[] = [];
  const streamStart = 'stream\n';
  const streamEnd = '\nendstream';
  let cursor = 0;
  while (true) {
    const marker = source.indexOf(streamStart, cursor);
    if (marker < 0) break;
    const dataStart = marker + streamStart.length;
    const dataEnd = source.indexOf(streamEnd, dataStart);
    if (dataEnd < 0) break;
    const header = source.slice(Math.max(0, marker - 120), marker);
    if (header.includes('/FlateDecode')) {
      const decoded = inflateSync(Buffer.from(source.slice(dataStart, dataEnd), 'latin1')).toString('latin1');
      for (const match of decoded.matchAll(/<([0-9a-f]+)>/gi)) {
        textParts.push(Buffer.from(match[1], 'hex').toString('latin1'));
      }
    }
    cursor = dataEnd + streamEnd.length;
  }
  return textParts.join(' ').replace(/\s+/g, ' ');
}

function compactPdfText(pdf: Buffer): string {
  return pdfText(pdf)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function decompressedPdfStreams(pdf: Buffer): string {
  const source = pdf.toString('latin1');
  const streams: string[] = [];
  const streamStart = 'stream\n';
  const streamEnd = '\nendstream';
  let cursor = 0;
  while (true) {
    const marker = source.indexOf(streamStart, cursor);
    if (marker < 0) break;
    const dataStart = marker + streamStart.length;
    const dataEnd = source.indexOf(streamEnd, dataStart);
    if (dataEnd < 0) break;
    const header = source.slice(Math.max(0, marker - 120), marker);
    if (header.includes('/FlateDecode')) {
      streams.push(
        inflateSync(Buffer.from(source.slice(dataStart, dataEnd), 'latin1')).toString('latin1'),
      );
    }
    cursor = dataEnd + streamEnd.length;
  }
  return streams.join('\n');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function syntheticAIInput(options: {
  paragraphCount?: number;
  paragraphMode?: string;
  longParagraph?: boolean;
} = {}): AIReportInput {
  const now = new Date('2026-10-18T16:00:00.000Z');
  const longText = `Párrafo sintético de evaluación: áéíóúñ. ${'La evidencia se interpreta dentro del contexto local y no reemplaza la revisión humana. '.repeat(7)}`;
  const paragraphCount = options.paragraphCount ?? 17;
  const paragraphTexts = Array.from({ length: paragraphCount }, () =>
    options.longParagraph
      ? `${longText} ${'Texto sintético extendido para verificar el ajuste de línea y los saltos de página. '.repeat(18)}`
      : longText,
  );
  const extractedText = paragraphTexts.join('\n\n');
  let sourceOffset = 0;
  return {
    reportId,
    generatedAt: now,
    turnitingVersion: '0.0.1-test',
    document: {
      id: '66b2f3c5-14df-4156-a1df-152a7129f88e',
      filename: 'muestra_sintetica.docx',
      createdAt: now,
      updatedAt: now,
    },
    extractedText,
    run: {
      id: '31ec6f6f-4be4-49da-9bf5-ccf9fe77aab4',
      status: 'COMPLETED',
      analyzerMode: 'V3_ONLY',
      analyzerVersion: 'synthetic-analyzer-v1',
      thresholdProfile: 'BALANCED',
      threshold: 0.58,
      paragraphMode: options.paragraphMode ?? 'CONTEXTUAL_PARAGRAPH',
      documentAggregation: 'token_weighted_mean',
      documentScore: 0.63,
      signalLevel: 'MODERATE',
      scoredSegments: paragraphCount,
      insufficientSegments: 2,
      inferenceMs: 412,
      cacheHit: false,
      metadata: {
        paragraphContext: {
          byParagraph: { '0': { V3: { before: 0, after: 9 } } },
        },
      },
      createdAt: now,
      completedAt: now,
      modelNames: ['SYNTHETIC_MODEL_V3'],
      modelVersions: ['synthetic-v3-fixture'],
    },
    paragraphs: paragraphTexts.map((textPreview, paragraphIndex) => {
      const charStart = sourceOffset;
      const charEnd = charStart + textPreview.length;
      sourceOffset = charEnd + 2;
      const insufficient = paragraphIndex === 4 || paragraphIndex === 5;
      return {
        paragraphIndex,
        textHash: sha256(textPreview.replace(/\s+/gu, ' ').trim()),
        charStart,
        charEnd,
        segmentEvidence: {
          type: 'PARAGRAPH',
          paragraphId: paragraphIndex,
          start: charStart,
          end: charEnd,
          score: insufficient ? null : paragraphIndex === 0 ? 0.74 : 0.31 + paragraphIndex / 100,
          level: insufficient ? null : paragraphIndex === 0 ? 'HIGH' : 'LOW',
        },
        score: insufficient
          ? null
          : paragraphIndex === 0
            ? 0.74
            : 0.31 + paragraphIndex / 100,
        signalLevel: insufficient
          ? null
          : paragraphIndex === 0
            ? 'HIGH'
            : 'LOW',
        classification: insufficient ? 'INSUFFICIENT_TEXT' : 'LOW_SIGNAL',
        reviewPresentation: {
          highlight: paragraphIndex === 0,
          level: insufficient ? null : paragraphIndex === 0 ? 'HIGH' : 'LOW',
        },
        textPreview,
        pageNumber: Math.floor(paragraphIndex / 30) + 1,
        words: 74,
        tokens: 96,
        contextTokensBefore: paragraphIndex === 0 ? 0 : undefined,
        contextTokensAfter: paragraphIndex === 0 ? 9 : undefined,
      };
    }),
    history: [
      {
        id: 'b47e8a0a-0261-48e7-b0d0-22c3d3cfdb12',
        createdAt: now,
        model: 'SYNTHETIC_MODEL_V3',
        paragraphMode: 'STRICT_PARAGRAPH',
        score: 0.55,
      },
    ],
    limitations: [
      'Fixture sintético: los resultados no corresponden a un documento ni a un modelo real.',
    ],
  };
}

function documentReviewAIInput(reverseSegments = false): AIReportInput {
  const base = syntheticAIInput({ paragraphCount: 2 });
  const sourceParagraphs = [
    {
      text: 'UNIVERSIDAD SINTÉTICA',
      score: 0.94,
      signalLevel: 'HIGH',
      classification: 'HIGH_SIGNAL',
    },
    {
      text: 'Autor: Ana Ejemplo',
      score: 0.92,
      signalLevel: 'HIGH',
      classification: 'HIGH_SIGNAL',
    },
    {
      text: 'ana@example.invalid',
      score: 0.89,
      signalLevel: 'HIGH',
      classification: 'HIGH_SIGNAL',
    },
    {
      text: '1.1 Identificación del problema',
      score: null,
      signalLevel: null,
      classification: 'INSUFFICIENT_TEXT',
    },
    {
      text: 'Metadato institucional: Universidad Sintética',
      score: null,
      signalLevel: null,
      classification: 'INSUFFICIENT_TEXT',
    },
    {
      text: 'El párrafo sintético de señal alta conserva el texto original.',
      score: 0.919,
      signalLevel: 'HIGH',
      classification: 'HIGH_SIGNAL',
    },
    {
      text: 'El párrafo sintético de señal moderada conserva el texto original.',
      score: 0.491,
      signalLevel: 'MODERATE',
      classification: 'MODERATE_SIGNAL',
    },
    {
      text: 'El párrafo sintético de señal baja conserva el texto original.',
      score: 0.241,
      signalLevel: 'LOW',
      classification: 'LOW_SIGNAL',
    },
    {
      text: 'Figura 1. Diagrama sintético del proceso.',
      score: 0.97,
      signalLevel: 'HIGH',
      classification: 'HIGH_SIGNAL',
    },
    {
      text: '1.2 Marco metodológico',
      score: null,
      signalLevel: null,
      classification: 'INSUFFICIENT_TEXT',
    },
    {
      text: 'Referencias',
      score: null,
      signalLevel: null,
      classification: 'INSUFFICIENT_TEXT',
    },
    {
      text: 'Smith, A. (2024). Registro sintético. https://doi.org/10.1000/synthetic [1]',
      score: 0.98,
      signalLevel: 'HIGH',
      classification: 'HIGH_SIGNAL',
    },
    {
      text: 'Jones, B. (2023). Referencia para pruebas. https://example.invalid/ref [2]',
      score: 0.96,
      signalLevel: 'HIGH',
      classification: 'HIGH_SIGNAL',
    },
    {
      text: 'Pérez, C. (2022). Cita sintética de verificación [3]',
      score: 0.95,
      signalLevel: 'HIGH',
      classification: 'HIGH_SIGNAL',
    },
  ];
  const extractedText = sourceParagraphs
    .map((paragraph) => paragraph.text)
    .join('\n\n');
  let sourceOffset = 0;
  const paragraphs = sourceParagraphs.map((source, paragraphIndex) => {
    const charStart = sourceOffset;
    const charEnd = charStart + source.text.length;
    sourceOffset = charEnd + 2;
    return {
      paragraphIndex,
      textHash: sha256(source.text),
      charStart,
      charEnd,
      segmentEvidence: {
        type: 'PARAGRAPH',
        paragraphId: paragraphIndex,
        start: charStart,
        end: charEnd,
        score: source.score,
        level: source.signalLevel,
      },
      score: source.score,
      signalLevel: source.signalLevel,
      classification: source.classification,
      textPreview: source.text,
      reviewPresentation: { highlight: false, level: null },
      pageNumber: 1,
      words: source.text.split(/\s+/u).length,
      tokens: 12,
    };
  });
  return {
    ...base,
    extractedText,
    paragraphs: reverseSegments ? paragraphs.reverse() : paragraphs,
  };
}

describe('ReportRenderer', () => {
  it('renders a clean multi-page AI PDF with the cover and full document review', async () => {
    const input = syntheticAIInput();
    const pdf = await renderer.renderAI(input);
    const content = compactPdfText(pdf);

    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.byteLength).toBeGreaterThan(2_000);
    expect(pageCount(pdf)).toBeGreaterThan(1);
    expect(content).toContain('muestra_sintetica.docx');
    expect(content).toContain('63.0%');
    expect(content).toContain('senalglobalestimada');
    expect(content).toContain('noesunreporteoficialdeturnitin');
    expect(content).toContain('parrafosseñalados'.normalize('NFD').replace(/\p{Diacritic}/gu, ''));
    expect(content).toContain('parrafosevaluados');
    expect(content).toContain('documentopararevision');
    expect(content).not.toContain('detalleporparrafo');
    expect(content).not.toContain('metodologia');
    expect(content).not.toContain('versiondelrenderer');
    expect(content).not.toContain('historialdeldocumento');
    expect(content).not.toContain('contextobreve|antes:');
    expect(content).not.toContain('synthetic_model_v3');
    expect(content).not.toContain('f005-local-analyzer-v1');
    expect(content).not.toContain('74.0%');
    expect(content).not.toContain('párrafo 1'.normalize('NFD').replace(/\p{Diacritic}/gu, ''));
    expect(content).toContain('turniting');
    expect(content).not.toContain(`id${reportId.slice(0, 8)}`);
    expect(pdf.toString('latin1')).toContain('/Count ');
  });

  it('renders technical scores at the exact persisted threshold and keeps insufficient text unevaluated', async () => {
    const input = syntheticAIInput({ paragraphCount: 6 });
    input.run.threshold = 0.644295302013423;
    input.paragraphs[0] = {
      ...input.paragraphs[0]!,
      score: 0.644295302013422,
      textPreview: 'One step below the threshold is not flagged.',
    };
    input.paragraphs[1] = {
      ...input.paragraphs[1]!,
      score: 0.644295302013423,
      textPreview: 'Exact threshold boundary is flagged.',
    };
    input.paragraphs[2] = {
      ...input.paragraphs[2]!,
      score: 0.644295302013424,
      textPreview: 'One step above the threshold is flagged.',
    };
    input.paragraphs[3] = {
      ...input.paragraphs[3]!,
      score: 0.78362,
      textPreview: 'Synthetic local score uses one decimal percent.',
    };
    input.paragraphs[4] = {
      ...input.paragraphs[4]!,
      score: null,
      textPreview: 'Insufficient paragraph has no score.',
    };
    input.paragraphs[5] = {
      ...input.paragraphs[5]!,
      score: 0.91,
      textPreview: 'Reference score remains visible and excluded from review.',
      presentationExcluded: true,
      excludedReason: 'REFERENCE_SECTION',
      reviewPresentation: {
        highlight: false,
        level: 'HIGH',
        excludedReason: 'REFERENCE_SECTION',
      },
    };
    const completeText = `Exact threshold boundary is flagged. ${'Synthetic full paragraph text remains available. '.repeat(60)}END_OF_SYNTHETIC_FULL_TEXT`;
    input.paragraphs[1]!.textPreview = completeText;

    const pdf = await renderer.renderAIParagraphTechnical(input);
    const content = compactPdfText(pdf);

    expect(pageCount(pdf)).toBeGreaterThan(1);
    expect(content).toContain('onestepbelowthethresholdisnotflagged');
    expect(content).toContain('exactthresholdboundaryisflagged');
    expect(content).toContain('onestepabovethethresholdisflagged');
    expect(content).toContain('78.4%');
    expect(content).toContain('end_of_synthetic_full_text');
    expect(content).toContain('referencescoreremainsvisibleandexcludedfromreview');
    expect(content).toContain('senalado');
    expect(content).toContain('noseñalado'.normalize('NFD').replace(/\p{Diacritic}/gu, ''));
    expect(content).toContain('noevaluado');
    expect(content).toContain('reference_section');
    expect(content).toContain('norepresentaelporcentajedecontribucionaritmeticadelparrafo');
    expect(content).not.toContain('0.0%');
  });

  it('renders compact reports for one-page source documents with five paragraphs and longer documents with thirty', async () => {
    const fiveParagraphPdf = await renderer.renderAI(
      syntheticAIInput({ paragraphCount: 5, paragraphMode: 'STRICT_PARAGRAPH' }),
    );
    const thirtyParagraphPdf = await renderer.renderAI(
      syntheticAIInput({ paragraphCount: 30, paragraphMode: 'STRICT_PARAGRAPH' }),
    );
    const strictContent = compactPdfText(fiveParagraphPdf);

    expect(pageCount(fiveParagraphPdf)).toBeGreaterThanOrEqual(1);
    expect(pageCount(thirtyParagraphPdf)).toBeGreaterThan(pageCount(fiveParagraphPdf));
    expect(strictContent).toContain('documentopararevision');
    expect(strictContent).not.toContain('contextobreve|antes:');
    expect(strictContent).not.toContain('detalleporparrafo');
  });

  it('wraps a very long synthetic paragraph across pages without losing the report footer', async () => {
    const pdf = await renderer.renderAI(
      syntheticAIInput({ paragraphCount: 5, longParagraph: true }),
    );
    const content = compactPdfText(pdf);

    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);
    expect(content).toContain('pagina1de');
    expect(content).toContain('reporteindependiente');
    expect(content).toContain('parrafosinteticodeevaluacion');
  });

  it('renders paragraph-relative UTF-16 evidence spans without duplicating source text', async () => {
    const input = syntheticAIInput({ paragraphCount: 1, paragraphMode: 'STRICT_PARAGRAPH' });
    const text = 'ABCDEFGHIJKLMN';
    input.extractedText = text;
    input.run.threshold = 0.8;
    input.paragraphs[0] = {
      ...input.paragraphs[0]!,
      paragraphIndex: 30,
      textHash: sha256(text),
      charStart: 0,
      charEnd: text.length,
      score: 0.8,
      signalLevel: 'HIGH',
      classification: 'MACHINE_SIGNAL',
      textPreview: text,
      segmentEvidence: {
        type: 'SPAN',
        paragraphId: 30,
        start: 0,
        end: text.length,
        score: 0.8,
        level: 'HIGH',
        spans: [{ startChar: 2, endChar: 5 }, { startChar: 8, endChar: 11 }],
      },
      reviewEvidence: {
        evaluated: true,
        flagged: true,
        score: 0.8,
        threshold: 0.8,
        presentationExcluded: false,
        granularity: 'SPAN',
        paragraphFlagged: true,
        spans: [{ startChar: 2, endChar: 5 }, { startChar: 8, endChar: 11 }],
      },
      reviewPresentation: { highlight: true, level: 'HIGH' },
    };
    const pdf = await renderer.renderAI(input);
    const content = compactPdfText(pdf);
    const drawing = decompressedPdfStreams(pdf);

    expect(content.match(/abcdefghijklmn/gu)).toHaveLength(1);
    expect(drawing.match(/0\.862745\d* 0\.929411\d* 0\.917647\d* scn/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);

    input.paragraphs[0] = {
      ...input.paragraphs[0]!,
      segmentEvidence: { ...input.paragraphs[0]!.segmentEvidence, spans: [] },
      reviewEvidence: { ...input.paragraphs[0]!.reviewEvidence!, spans: [] },
    };
    const fallbackPdf = await renderer.renderAI(input);
    const fallbackDrawing = decompressedPdfStreams(fallbackPdf);
    expect(fallbackDrawing.match(/0\.862745\d* 0\.929411\d* 0\.917647\d* scn/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('renders the document review in source order with paragraph-level signal highlights and reference exclusion', async () => {
    const pdf = await renderer.renderAI(documentReviewAIInput(true));
    const text = compactPdfText(pdf);
    const drawing = decompressedPdfStreams(pdf);
    const reviewStart = text.indexOf('documentopararevision');
    const reviewText = text.slice(reviewStart);
    const orderedText = [
      'universidadsintetica',
      'autor:anaejemplo',
      'ana@example.invalid',
      '1.1identificaciondelproblema',
      'metadatoinstitucional:universidadsintetica',
      'elparrafosinteticodesenalaltaconservaeltextooriginal',
      'elparrafosinteticodesenalmoderadaconservaeltextooriginal',
      'elparrafosinteticodesenalbajaconservaeltextooriginal',
      'figura1.diagramasinteticodelproceso.',
      '1.2marcometodologico',
      'referencias',
      'smith,a.(2024).registrosintetico.https://doi.org/10.1000/synthetic[1]',
      'jones,b.(2023).referenciaparapruebas.https://example.invalid/ref[2]',
      'perez,c.(2022).citasinteticadeverificacion[3]',
    ];

    expect(reviewStart).toBeGreaterThanOrEqual(0);
    let previous = reviewStart;
    for (const phrase of orderedText) {
      const position = text.indexOf(phrase, reviewStart);
      expect(position, phrase).toBeGreaterThan(previous);
      expect(position, phrase).toBeLessThan(text.length);
      previous = position;
    }
    expect(reviewText).toContain('resaltado:segmentoigualosuperioralumbralaplicado');
    expect(text).not.toContain('91.9%');
    expect(text).not.toContain('49.1%');
    expect(text).not.toContain('24.1%');
    expect(text).not.toContain('detalleporparrafo');
    expect(text).not.toContain('unidaddeanalisisdelmodelo');
    expect(drawing.match(/0\.862745\d* 0\.929411\d* 0\.917647\d* scn/gu)?.length ?? 0).toBeGreaterThan(0);
    expect(drawing).not.toMatch(/0\.952941\d* 0\.945098\d* 0\.909803\d* scn/);
  });

  it('rejects document review segments whose offsets no longer match their persisted hashes', async () => {
    const input = documentReviewAIInput();
    input.paragraphs[2]!.charEnd -= 1;

    await expect(renderer.renderAI(input)).rejects.toMatchObject({
      name: 'ReportReviewIntegrityError',
      code: 'ANALYSIS_SEGMENT_TEXT_MISMATCH',
    });
  });

  it('renders a synthetic similarity fixture using the supplied matched coverage', async () => {
    const fixtureRoot = new URL(
      '../../test/fixtures/reports/similarity/',
      import.meta.url,
    );
    const [queryText, sourceAText, sourceBText] = await Promise.all([
      readFile(new URL('query.txt', fixtureRoot), 'utf8'),
      readFile(new URL('source-a.txt', fixtureRoot), 'utf8'),
      readFile(new URL('source-b.txt', fixtureRoot), 'utf8'),
    ]);
    const now = new Date('2026-10-18T16:00:00.000Z');
    const input: SimilarityReportInput = {
      reportId,
      generatedAt: now,
      document: {
        id: '66b2f3c5-14df-4156-a1df-152a7129f88e',
        filename: 'muestra_sintetica.txt',
        createdAt: now,
      },
      run: { id: '113837b4-0f7a-49f0-b8af-6c466889d8a6', createdAt: now },
      similarityScore: 0.41,
      matchedCoverage: 0.28,
      eligibleTokens: 14,
      matchedTokens: 4,
      excludedTokens: 2,
      sources: [
        {
          sourceId: 'fixture-source-a',
          title: 'Fuente sintética A',
          url: 'https://example.invalid/source-a',
          contribution: 0.21,
          bestScore: 0.77,
          bestMatchType: 'NEAR_COPY',
          matches: [
            {
              queryStart: 0,
              queryEnd: queryText.trim().length,
              sourceStart: 0,
              sourceEnd: sourceAText.trim().length,
              queryText: queryText.trim(),
              sourceText: sourceAText.trim(),
              matchType: 'NEAR_COPY',
              matchedCoverage: 0.28,
              lexicalScore: 0.77,
              semanticScore: 0.72,
              rerankerScore: 0.8,
            },
          ],
        },
        {
          sourceId: 'fixture-source-b',
          title: 'Fuente sintética B',
          url: 'https://example.invalid/source-b',
          contribution: 0.07,
          bestScore: 0.35,
          bestMatchType: 'RELATED_NOT_COUNTED',
          matches: [
            {
              queryStart: 1,
              queryEnd: 12,
              queryText,
              sourceText: sourceBText.trim(),
              matchType: 'RELATED_NOT_COUNTED',
              matchedCoverage: 0,
            },
          ],
        },
      ],
      exclusions: [{ label: 'Referencia sintética', count: 1, tokens: 2 }],
      limitations: ['Fixture sintético sin resultados F008 reales.'],
    };

    const pdf = await renderer.renderSimilarity(input);

    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.byteLength).toBeGreaterThan(1_000);
    expect(pageCount(pdf)).toBeGreaterThan(0);
  });
});
