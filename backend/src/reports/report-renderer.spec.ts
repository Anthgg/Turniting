import { readFile } from 'node:fs/promises';
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

function syntheticAIInput(options: {
  paragraphCount?: number;
  paragraphMode?: string;
  longParagraph?: boolean;
} = {}): AIReportInput {
  const now = new Date('2026-10-18T16:00:00.000Z');
  const longText = `Párrafo sintético de evaluación: áéíóúñ. ${'La evidencia se interpreta dentro del contexto local y no reemplaza la revisión humana. '.repeat(7)}`;
  const paragraphCount = options.paragraphCount ?? 17;
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
    paragraphs: Array.from({ length: paragraphCount }, (_, paragraphIndex) => ({
      paragraphIndex,
      score: paragraphIndex === 0 ? 0.74 : 0.31 + paragraphIndex / 100,
      signalLevel: paragraphIndex === 0 ? 'HIGH' : 'LOW',
      classification: 'LOW_SIGNAL',
      textPreview: options.longParagraph
        ? `${longText} ${'Texto sintético extendido para verificar el ajuste de línea y los saltos de página. '.repeat(18)}`
        : longText,
      pageNumber: Math.floor(paragraphIndex / 30) + 1,
      words: 74,
      tokens: 96,
      contextTokensBefore: paragraphIndex === 0 ? 0 : undefined,
      contextTokensAfter: paragraphIndex === 0 ? 9 : undefined,
    })).map((paragraph, index) =>
      index === 4 || index === 5
        ? {
            ...paragraph,
            score: null,
            signalLevel: null,
            classification: 'INSUFFICIENT_TEXT',
          }
        : paragraph,
    ),
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

describe('ReportRenderer', () => {
  it('renders a multi-page AI PDF with contextual counts and grouped insufficient paragraphs', async () => {
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
    expect(content).toContain('detalleporparrafo');
    expect(content).toContain('metodologia');
    expect(content).toContain('versiondelrenderer');
    expect(content).toContain('historialdeldocumento');
    expect(content).toContain('limitacionesaplicablesaestemodelo/run');
    expect(content).toContain('contextobreve|antes:0tokens|despues:9tokens');
    expect(content).toContain('turniting');
    expect(content).toContain(`id${reportId.slice(0, 8)}`);
    expect(pdf.toString('latin1')).toContain('/Count ');
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
    expect(strictContent).toContain('soloelparrafo');
    expect(strictContent).not.toContain('contextobreve|antes:');
    expect(strictContent).toContain('bloquesintextosuficienteparaevaluacion');
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
    expect(content).toContain('parrafo1');
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
