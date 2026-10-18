import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import type {
  AIReportInput,
  AIReportParagraph,
  SimilarityMatch,
  SimilarityReportInput,
} from './report.contracts.js';

export const REPORT_RENDERER_VERSION = 'f0091-report-renderer-v2';

const PAGE = { width: 595.28, height: 841.89 };
const COLOR = {
  ink: '#172b42',
  muted: '#5d6c7d',
  line: '#d9e1e8',
  panel: '#f4f7f9',
  blue: '#315c7d',
  high: '#46596b',
  moderate: '#718096',
  low: '#2f7164',
  insufficient: '#a7b0ba',
  white: '#ffffff',
};

const AI_DISCLAIMER =
  'Turniting proporciona una estimación probabilística independiente. No es un reporte oficial de Turnitin y no constituye por sí solo prueba de autoría o uso de inteligencia artificial.';
const SIMILARITY_DISCLAIMER =
  'Turniting compara el documento contra las fuentes disponibles en su corpus e índices configurados. La ausencia de una coincidencia no demuestra originalidad absoluta y el porcentaje no equivale al índice de similitud oficial de Turnitin.';

type PDFDoc = InstanceType<typeof PDFDocument>;
type DistributionLevel = 'HIGH' | 'MODERATE' | 'LOW' | 'INSUFFICIENT';

function cleanText(value: unknown, max = 800): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function percentage(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)} %`
    : 'No disponible';
}

function levelFor(paragraph: AIReportParagraph): DistributionLevel {
  if (
    paragraph.classification === 'INSUFFICIENT_TEXT' ||
    paragraph.score === null
  )
    return 'INSUFFICIENT';
  const level = paragraph.signalLevel?.toUpperCase();
  if (level === 'HIGH' || level === 'MODERATE' || level === 'LOW') return level;
  if (paragraph.score < 0.35) return 'LOW';
  if (paragraph.score < 0.65) return 'MODERATE';
  return 'HIGH';
}

function levelLabel(level: DistributionLevel): string {
  return {
    HIGH: 'Alta',
    MODERATE: 'Moderada',
    LOW: 'Baja',
    INSUFFICIENT: 'Insuficiente',
  }[level];
}

function levelColor(level: DistributionLevel): string {
  return {
    HIGH: COLOR.high,
    MODERATE: COLOR.moderate,
    LOW: COLOR.low,
    INSUFFICIENT: COLOR.insufficient,
  }[level];
}

function dateLabel(value: Date | null | undefined): string {
  if (!value || Number.isNaN(value.getTime())) return 'No disponible';
  return new Intl.DateTimeFormat('es-PE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Lima',
  }).format(value);
}

function formatDuration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'No disponible';
  if (value < 1000) return `${Math.max(0, Math.round(value))} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function paragraphModeLabel(value: string | null | undefined): string {
  if (value === 'STRICT_PARAGRAPH') return 'Solo el párrafo';
  if (value === 'CONTEXTUAL_PARAGRAPH') return 'Contexto breve';
  return value ?? 'No disponible';
}

function addFooter(doc: PDFDoc, reportId: string): void {
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    const originalBottomMargin = doc.page.margins.bottom;
    // Footer text lives inside the reserved bottom band. Temporarily widen
    // PDFKit's text area so it does not auto-create a trailing blank page.
    doc.page.margins.bottom = 36;
    const y = PAGE.height - 55;
    doc.save();
    doc
      .strokeColor(COLOR.line)
      .lineWidth(0.6)
      .moveTo(48, y - 9)
      .lineTo(PAGE.width - 48, y - 9)
      .stroke();
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLOR.muted)
      .text(
        `Turniting | Reporte independiente | Página ${index - range.start + 1} de ${range.count} | ID ${reportId.slice(0, 8)}`,
        48,
        y,
        {
          width: PAGE.width - 96,
          align: 'center',
          lineBreak: false,
        },
      );
    doc.restore();
    doc.page.margins.bottom = originalBottomMargin;
  }
}

@Injectable()
export class ReportRenderer {
  renderAI(input: AIReportInput): Promise<Buffer> {
    return this.renderPdf(
      'Reporte de señal de IA',
      input.reportId,
      input.generatedAt,
      (doc) => {
        this.aiCoverAndSummary(doc, input);
        this.aiDistribution(doc, input.paragraphs);
        this.aiParagraphs(
          doc,
          input.paragraphs,
          input.run.paragraphMode,
          input.run.metadata,
        );
        this.aiHistory(doc, input.history);
        this.aiMethodology(doc, input);
        this.aiLimitations(doc, input.limitations);
      },
    );
  }

  renderSimilarity(input: SimilarityReportInput): Promise<Buffer> {
    return this.renderPdf(
      'Reporte independiente de similitud',
      input.reportId,
      input.generatedAt,
      (doc) => {
        this.similarityCoverAndSummary(doc, input);
        this.similaritySources(doc, input.sources);
        this.similarityExclusions(doc, input.exclusions ?? []);
        this.similarityLimitations(doc, input.limitations);
      },
    );
  }

  private renderPdf(
    title: string,
    reportId: string,
    generatedAt: Date,
    draw: (doc: PDFDoc) => void,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 48, right: 48, bottom: 84, left: 48 },
        bufferPages: true,
        compress: true,
        info: { Title: title, Author: 'Turniting', CreationDate: generatedAt },
      });
      doc.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      doc.on('error', reject);
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      try {
        draw(doc);
        addFooter(doc, reportId);
        doc.end();
      } catch (error) {
        reject(error);
        doc.end();
      }
    });
  }

  private brand(doc: PDFDoc, subtitle: string): void {
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(COLOR.blue)
      .text('TURNITING', 48, 46, { characterSpacing: 1.4 });
    doc.moveDown(1.6);
    doc
      .font('Helvetica-Bold')
      .fontSize(25)
      .fillColor(COLOR.ink)
      .text(subtitle, 48, doc.y, { width: 499 });
  }

  private section(doc: PDFDoc, title: string): void {
    this.ensureSpace(doc, 54);
    doc.moveDown(1.1);
    doc.x = doc.page.margins.left;
    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .fillColor(COLOR.ink)
      .text(title, doc.page.margins.left, doc.y);
    const y = doc.y + 5;
    doc
      .strokeColor(COLOR.line)
      .lineWidth(0.8)
      .moveTo(doc.page.margins.left, y)
      .lineTo(PAGE.width - doc.page.margins.right, y)
      .stroke();
    doc.moveDown(0.7);
  }

  private ensureSpace(doc: PDFDoc, height: number): void {
    if (doc.y + height > PAGE.height - doc.page.margins.bottom) doc.addPage();
  }

  private keyValue(
    doc: PDFDoc,
    label: string,
    value: string,
    x: number,
    y: number,
    width = 220,
  ): void {
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLOR.muted)
      .text(label.toUpperCase(), x, y, { width });
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(COLOR.ink)
      .text(value, x, y + 13, { width });
  }

  private aiCoverAndSummary(doc: PDFDoc, input: AIReportInput): void {
    this.brand(doc, 'Reporte independiente de señal de IA');
    doc.moveDown(0.8);
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(COLOR.muted)
      .text(
        'Estimación probabilística del texto analizado; no equivale a una decisión de autoría.',
      );
    doc.moveDown(1.1);
    this.keyValue(
      doc,
      'Documento',
      cleanText(input.document.filename, 160) || 'Documento',
      48,
      doc.y,
      490,
    );
    doc.moveDown(1.3);
    const metaY = doc.y;
    this.keyValue(
      doc,
      'Fecha del documento',
      dateLabel(input.document.createdAt),
      48,
      metaY,
    );
    this.keyValue(
      doc,
      'Fecha del análisis',
      dateLabel(input.run.completedAt ?? input.run.createdAt),
      290,
      metaY,
    );
    this.keyValue(doc, 'Run ID', input.run.id.slice(0, 8), 48, metaY + 43);
    this.keyValue(
      doc,
      'Fecha de generación',
      dateLabel(input.generatedAt),
      290,
      metaY + 43,
    );
    doc.y = metaY + 92;

    this.section(doc, 'Resumen');
    const cardY = doc.y;
    doc.save().roundedRect(48, cardY, 499, 100, 8).fill(COLOR.panel).restore();
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLOR.muted)
      .text('SEÑAL GLOBAL ESTIMADA', 64, cardY + 14);
    doc
      .font('Helvetica-Bold')
      .fontSize(32)
      .fillColor(COLOR.ink)
      .text(percentage(input.run.documentScore), 64, cardY + 29, {
        width: 190,
      });
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(
        levelColor(
          levelFromRun(input.run.signalLevel, input.run.documentScore),
        ),
      )
      .text(
        `Nivel: ${levelLabel(levelFromRun(input.run.signalLevel, input.run.documentScore))}`,
        300,
        cardY + 42,
        { width: 220 },
      );
    doc.y = cardY + 114;

    const total = input.paragraphs.length;
    const evaluated = input.paragraphs.filter(
      (paragraph) => levelFor(paragraph) !== 'INSUFFICIENT',
    ).length;
    const insufficient = total - evaluated;
    this.keyValue(
      doc,
      'Analizador/modelo',
      input.run.modelNames.join(' + ') || input.run.analyzerMode,
      48,
      doc.y,
      240,
    );
    this.keyValue(doc, 'Perfil', input.run.thresholdProfile, 300, doc.y, 220);
    const rowY = doc.y + 43;
    this.keyValue(
      doc,
      'Modo de párrafo',
      paragraphModeLabel(input.run.paragraphMode),
      48,
      rowY,
    );
    this.keyValue(
      doc,
      'Umbral aplicado',
      input.run.threshold === null
        ? 'No disponible'
        : percentage(input.run.threshold),
      300,
      rowY,
    );
    const row2Y = rowY + 43;
    this.keyValue(doc, 'Párrafos totales', `${total}`, 48, row2Y);
    this.keyValue(doc, 'Párrafos evaluados', `${evaluated}`, 200, row2Y);
    this.keyValue(doc, 'Insuficientes', `${insufficient}`, 360, row2Y);
    const row3Y = row2Y + 43;
    this.keyValue(
      doc,
      'Duración de inferencia',
      formatDuration(input.run.inferenceMs),
      48,
      row3Y,
    );
    this.keyValue(
      doc,
      'Resultado desde caché',
      input.run.cacheHit ? 'Sí' : 'No',
      245,
      row3Y,
    );
    this.keyValue(
      doc,
      'Agregación',
      input.run.documentAggregation ?? 'No disponible',
      370,
      row3Y,
      170,
    );
    doc.y = row3Y + 48;

    doc.save().roundedRect(48, doc.y, 499, 56, 6).fill('#f6f8fa').restore();
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(COLOR.ink)
      .text(AI_DISCLAIMER, 61, doc.y + 11, {
        width: 473,
        height: 38,
        lineGap: 1.5,
      });
    doc.y += 69;
  }

  private aiDistribution(doc: PDFDoc, paragraphs: AIReportParagraph[]): void {
    this.section(doc, 'Distribución de señal por párrafo');
    const levels: DistributionLevel[] = [
      'HIGH',
      'MODERATE',
      'LOW',
      'INSUFFICIENT',
    ];
    const counts = Object.fromEntries(
      levels.map((level) => [level, 0]),
    ) as Record<DistributionLevel, number>;
    paragraphs.forEach((paragraph) => {
      counts[levelFor(paragraph)] += 1;
    });
    const total = paragraphs.length;
    const barX = 48;
    const barY = doc.y;
    const barWidth = 499;
    const barHeight = 15;
    let offset = 0;
    for (const level of levels) {
      const width = total === 0 ? 0 : (barWidth * counts[level]) / total;
      if (width > 0)
        doc.rect(barX + offset, barY, width, barHeight).fill(levelColor(level));
      offset += width;
    }
    if (total === 0)
      doc.roundedRect(barX, barY, barWidth, barHeight, 4).fill(COLOR.line);
    doc.y = barY + 27;
    for (const level of levels) {
      const count = counts[level];
      const share = total ? `${((count / total) * 100).toFixed(1)} %` : '0.0 %';
      doc.circle(54, doc.y + 4, 3.5).fill(levelColor(level));
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(COLOR.ink)
        .text(levelLabel(level), 64, doc.y, { width: 100 });
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(COLOR.muted)
        .text(`${count} | ${share}`, 164, doc.y, { width: 100 });
      doc.y += 17;
    }
    doc.moveDown(0.2);
  }

  private aiParagraphs(
    doc: PDFDoc,
    paragraphs: AIReportParagraph[],
    paragraphMode: string | null,
    metadata: unknown,
  ): void {
    this.section(doc, 'Detalle por párrafo');
    if (paragraphMode === 'CONTEXTUAL_PARAGRAPH') {
      doc
        .font('Helvetica-Oblique')
        .fontSize(9)
        .fillColor(COLOR.muted)
        .text(
          'Este run utilizó contexto breve. Se muestran solo los conteos de tokens disponibles; los párrafos vecinos completos no se incluyen.',
        );
      doc.moveDown(0.8);
    }

    let index = 0;
    while (index < paragraphs.length) {
      const paragraph = paragraphs[index];
      if (levelFor(paragraph) === 'INSUFFICIENT') {
        const first = paragraph.paragraphIndex;
        let last = first;
        let count = 1;
        while (index + count < paragraphs.length) {
          const next = paragraphs[index + count];
          if (
            levelFor(next) !== 'INSUFFICIENT' ||
            next.paragraphIndex !== last + 1
          )
            break;
          last = next.paragraphIndex;
          count += 1;
        }
        this.insufficientBlock(doc, first, last, count);
        index += count;
      } else {
        this.paragraphCard(doc, paragraph, paragraphMode, metadata);
        index += 1;
      }
    }
  }

  private insufficientBlock(
    doc: PDFDoc,
    first: number,
    last: number,
    count: number,
  ): void {
    this.ensureSpace(doc, 53);
    const y = doc.y;
    doc.save().roundedRect(48, y, 499, 41, 6).fill('#f1f3f5').restore();
    const range =
      first === last
        ? `Párrafo ${first + 1}`
        : `Párrafos ${first + 1}–${last + 1}`;
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(COLOR.ink)
      .text(range, 61, y + 8);
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLOR.muted)
      .text(
        `${count} ${count === 1 ? 'bloque sin' : 'bloques sin'} texto suficiente para evaluación`,
        61,
        y + 22,
      );
    doc.y = y + 51;
  }

  private paragraphCard(
    doc: PDFDoc,
    paragraph: AIReportParagraph,
    paragraphMode: string | null,
    metadata: unknown,
  ): void {
    const level = levelFor(paragraph);
    const preview =
      cleanText(paragraph.textPreview, 720) || 'Vista previa no disponible.';
    doc.font('Helvetica').fontSize(9);
    const bodyHeight = doc.heightOfString(preview, { width: 467, lineGap: 2 });
    const estimated = Math.max(83, bodyHeight + 58);
    this.ensureSpace(doc, Math.min(estimated, PAGE.height - 115));
    let y = doc.y;
    doc
      .save()
      .roundedRect(48, y, 499, estimated, 6)
      .fill(COLOR.panel)
      .restore();
    doc
      .save()
      .roundedRect(48, y, 5, estimated, 2)
      .fill(levelColor(level))
      .restore();
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(COLOR.ink)
      .text(`Párrafo ${paragraph.paragraphIndex + 1}`, 62, y + 10, {
        width: 190,
      });
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(levelColor(level))
      .text(
        `${percentage(paragraph.score)} | ${levelLabel(level)}`,
        350,
        y + 10,
        { width: 180, align: 'right' },
      );
    const details = [
      paragraph.pageNumber === null ? '' : `pág. ${paragraph.pageNumber}`,
      paragraph.words === null ? '' : `${paragraph.words} palabras`,
      paragraph.tokens === null ? '' : `${paragraph.tokens} tokens`,
    ]
      .filter(Boolean)
      .join(' | ');
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLOR.muted)
      .text(details || paragraph.classification, 62, y + 27, { width: 465 });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(COLOR.ink)
      .text(preview, 62, y + 42, { width: 467, lineGap: 2 });
    let tail = y + estimated - 14;
    if (paragraph.modelScores?.length) {
      const scores = paragraph.modelScores
        .map(
          (score) =>
            `${cleanText(score.modelName, 48)} ${percentage(score.score)}`,
        )
        .join(' | ');
      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(COLOR.muted)
        .text(scores, 62, tail, { width: 465 });
      tail -= 11;
    }
    if (paragraphMode === 'CONTEXTUAL_PARAGRAPH') {
      const stored = readContextCounts(metadata, paragraph.paragraphIndex);
      const before = paragraph.contextTokensBefore ?? stored.before;
      const after = paragraph.contextTokensAfter ?? stored.after;
      if (before !== undefined || after !== undefined) {
        doc
          .font('Helvetica')
          .fontSize(7.5)
          .fillColor(COLOR.muted)
          .text(
            `Contexto breve | antes: ${before ?? '—'} tokens | después: ${after ?? '—'} tokens`,
            62,
            tail,
            { width: 465 },
          );
      }
    }
    doc.y = y + estimated + 9;
  }

  private aiHistory(doc: PDFDoc, history: AIReportInput['history']): void {
    this.section(doc, 'Historial del documento');
    if (!history.length) {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(COLOR.muted)
        .text('No hay otras corridas completadas para esta versión.');
      return;
    }
    history.slice(0, 7).forEach((item) => {
      this.ensureSpace(doc, 27);
      const y = doc.y;
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(COLOR.ink)
        .text(dateLabel(item.createdAt), 48, y, { width: 112 });
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(COLOR.ink)
        .text(cleanText(item.model, 72) || 'Modelo', 166, y, { width: 160 });
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(COLOR.muted)
        .text(paragraphModeLabel(item.paragraphMode), 328, y, { width: 92 });
      doc
        .font('Helvetica-Bold')
        .fontSize(8.5)
        .fillColor(COLOR.ink)
        .text(percentage(item.score), 430, y, { width: 104, align: 'right' });
      doc.y += 16;
    });
  }

  private aiMethodology(doc: PDFDoc, input: AIReportInput): void {
    this.section(doc, 'Metodología');
    const lines = [
      `Analizador: ${input.run.modelNames.join(' + ') || input.run.analyzerMode}`,
      `Versión(es) del modelo: ${input.run.modelVersions.join(' + ') || 'no disponible'}`,
      `Versión del analizador: ${input.run.analyzerVersion}`,
      `Umbral y perfil: ${input.run.threshold === null ? 'no disponible' : percentage(input.run.threshold)} | ${input.run.thresholdProfile}`,
      `Modo de párrafo: ${paragraphModeLabel(input.run.paragraphMode)}`,
      `Agregación: ${input.run.documentAggregation ?? 'no disponible'}`,
      `Run ID: ${input.run.id}`,
      `Generado: ${dateLabel(input.generatedAt)}`,
      `Turniting: ${input.turnitingVersion}`,
      `Versión del renderer: ${REPORT_RENDERER_VERSION}`,
    ];
    lines.forEach((line) => {
      this.ensureSpace(doc, 18);
      doc.x = doc.page.margins.left;
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(COLOR.ink)
        .text(cleanText(line, 220), doc.page.margins.left, doc.y, {
          width: 499,
        });
      doc.moveDown(0.25);
    });
  }

  private aiLimitations(doc: PDFDoc, limitations: string[]): void {
    if (!limitations.length) return;
    this.section(doc, 'Limitaciones aplicables a este modelo/run');
    limitations.forEach((limitation) => {
      this.ensureSpace(doc, 25);
      doc.x = doc.page.margins.left;
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(COLOR.ink)
        .text(`- ${cleanText(limitation, 380)}`, doc.page.margins.left, doc.y, {
          width: 499,
          lineGap: 2,
        });
      doc.moveDown(0.3);
    });
  }

  private similarityCoverAndSummary(
    doc: PDFDoc,
    input: SimilarityReportInput,
  ): void {
    this.brand(doc, 'Reporte independiente de similitud');
    doc.moveDown(0.8);
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(COLOR.muted)
      .text(
        'Comparación contra las fuentes disponibles en el corpus configurado.',
      );
    doc.moveDown(1.1);
    this.keyValue(
      doc,
      'Documento',
      cleanText(input.document.filename, 160) || 'Documento',
      48,
      doc.y,
      490,
    );
    doc.moveDown(1.3);
    const metaY = doc.y;
    this.keyValue(
      doc,
      'Fecha del documento',
      dateLabel(input.document.createdAt),
      48,
      metaY,
    );
    this.keyValue(doc, 'Similarity Run ID', input.run.id, 290, metaY);
    this.keyValue(
      doc,
      'Fecha de generación',
      dateLabel(input.generatedAt),
      48,
      metaY + 43,
    );
    this.keyValue(
      doc,
      'Fuentes encontradas',
      `${input.sources.length}`,
      290,
      metaY + 43,
    );
    doc.y = metaY + 92;

    this.section(doc, 'Resumen');
    const y = doc.y;
    doc.save().roundedRect(48, y, 499, 84, 8).fill(COLOR.panel).restore();
    this.keyValue(
      doc,
      'Similarity',
      percentage(input.similarityScore),
      64,
      y + 15,
      140,
    );
    this.keyValue(
      doc,
      'Matched coverage',
      percentage(input.matchedCoverage),
      230,
      y + 15,
      140,
    );
    this.keyValue(
      doc,
      'Tokens elegibles',
      input.eligibleTokens.toLocaleString('es-PE'),
      390,
      y + 15,
      130,
    );
    doc.y = y + 100;
    this.keyValue(
      doc,
      'Tokens coincidentes',
      input.matchedTokens.toLocaleString('es-PE'),
      48,
      doc.y,
      220,
    );
    this.keyValue(
      doc,
      'Tokens excluidos',
      input.excludedTokens.toLocaleString('es-PE'),
      290,
      doc.y,
      220,
    );
    doc.y += 47;
    doc.save().roundedRect(48, doc.y, 499, 70, 6).fill('#f6f8fa').restore();
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(COLOR.ink)
      .text(SIMILARITY_DISCLAIMER, 61, doc.y + 10, {
        width: 473,
        height: 51,
        lineGap: 1.5,
      });
    doc.y += 82;
  }

  private similaritySources(
    doc: PDFDoc,
    sources: SimilarityReportInput['sources'],
  ): void {
    this.ensureSpace(doc, sources.length ? 238 : 58);
    this.section(doc, 'Fuentes y coincidencias');
    if (!sources.length) {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(COLOR.muted)
        .text('No se reportaron fuentes para este run.');
      return;
    }
    sources.forEach((source, index) => {
      const title = cleanText(source.title, 180) || `Fuente ${index + 1}`;
      // Keep the source heading with its first match when both are present.
      this.ensureSpace(doc, source.matches.length ? 184 : 92);
      let y = doc.y;
      doc.save().roundedRect(48, y, 499, 55, 6).fill(COLOR.panel).restore();
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor(COLOR.ink)
        .text(`#${index + 1} | ${title}`, 60, y + 9, { width: 475 });
      const safeUrl = safeHttpUrl(source.url);
      if (safeUrl)
        doc
          .font('Helvetica')
          .fontSize(7.5)
          .fillColor(COLOR.blue)
          .text(safeUrl, 60, y + 24, { width: 470, ellipsis: true });
      const bestType = source.bestMatchType
        ? matchTypeLabel(source.bestMatchType)
        : 'No disponible';
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(COLOR.muted)
        .text(
          `Aporte ${percentage(source.contribution)} | ${source.matches.length} coincidencias | mejor tipo: ${bestType}`,
          60,
          y + (safeUrl ? 38 : 27),
          { width: 475 },
        );
      doc.y = y + 65;
      source.matches.forEach((match, matchIndex) => {
        this.similarityMatch(doc, match, matchIndex + 1);
      });
      doc.moveDown(0.45);
    });
  }

  private similarityMatch(
    doc: PDFDoc,
    match: SimilarityMatch,
    index: number,
  ): void {
    const queryText =
      cleanText(match.queryText, 520) ||
      'Fragmento de documento no disponible.';
    const sourceText =
      cleanText(match.sourceText, 520) || 'Fragmento de fuente no disponible.';
    const height = 108;
    this.ensureSpace(doc, height + 7);
    let y = doc.y;
    doc.save().roundedRect(56, y, 491, height, 5).fill(COLOR.white).restore();
    doc.save().roundedRect(56, y, 3, height, 1).fill(COLOR.blue).restore();
    doc
      .font('Helvetica-Bold')
      .fontSize(8.5)
      .fillColor(COLOR.ink)
      .text(
        `Coincidencia ${index} | ${matchTypeLabel(match.matchType)} | cobertura ${percentage(match.matchedCoverage)}`,
        68,
        y + 8,
        { width: 465 },
      );
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor(COLOR.muted)
      .text('DOCUMENTO', 68, y + 25);
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLOR.ink)
      .text(queryText, 68, y + 36, { width: 465, height: 25, ellipsis: true });
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor(COLOR.muted)
      .text('FUENTE', 68, y + 64);
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLOR.ink)
      .text(sourceText, 68, y + 75, { width: 465, height: 22, ellipsis: true });
    const evidence = [
      match.lexicalScore === undefined
        ? ''
        : `léxico ${percentage(match.lexicalScore)}`,
      match.semanticScore === undefined
        ? ''
        : `semántico ${percentage(match.semanticScore)}`,
      match.rerankerScore === undefined
        ? ''
        : `reranker ${percentage(match.rerankerScore)}`,
    ]
      .filter(Boolean)
      .join(' | ');
    if (evidence)
      doc
        .font('Helvetica')
        .fontSize(7)
        .fillColor(COLOR.muted)
        .text(evidence, 68, y + 98, { width: 465 });
    doc.y = y + height + 8;
  }

  private similarityExclusions(
    doc: PDFDoc,
    exclusions: NonNullable<SimilarityReportInput['exclusions']>,
  ): void {
    if (!exclusions.length) return;
    this.section(doc, 'Exclusiones reportadas');
    exclusions.forEach((exclusion) => {
      this.ensureSpace(doc, 22);
      const tokens =
        exclusion.tokens === undefined
          ? ''
          : ` | ${exclusion.tokens.toLocaleString('es-PE')} tokens`;
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(COLOR.ink)
        .text(
          `${cleanText(exclusion.label, 120)} | ${exclusion.count.toLocaleString('es-PE')} elementos${tokens}`,
          doc.page.margins.left,
          doc.y,
          { width: 499 },
        );
      doc.moveDown(0.25);
    });
  }

  private similarityLimitations(doc: PDFDoc, limitations: string[]): void {
    if (!limitations.length) return;
    this.section(doc, 'Limitaciones');
    limitations.forEach((limitation) => {
      this.ensureSpace(doc, 25);
      doc.x = doc.page.margins.left;
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(COLOR.ink)
        .text(`- ${cleanText(limitation, 380)}`, doc.page.margins.left, doc.y, {
          width: 499,
          lineGap: 2,
        });
      doc.moveDown(0.3);
    });
  }
}

function levelFromRun(
  level: string | null,
  score: number | null,
): DistributionLevel {
  const normalized = level?.toUpperCase();
  if (
    normalized === 'HIGH' ||
    normalized === 'MODERATE' ||
    normalized === 'LOW'
  )
    return normalized;
  if (score === null) return 'INSUFFICIENT';
  if (score < 0.35) return 'LOW';
  if (score < 0.65) return 'MODERATE';
  return 'HIGH';
}

function readContextCounts(
  metadata: unknown,
  paragraphIndex: number,
): { before?: number; after?: number } {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    return {};
  const root = metadata as Record<string, unknown>;
  const paragraphContext = root.paragraphContext;
  if (
    !paragraphContext ||
    typeof paragraphContext !== 'object' ||
    Array.isArray(paragraphContext)
  )
    return {};
  const byParagraph = (paragraphContext as Record<string, unknown>).byParagraph;
  if (
    !byParagraph ||
    typeof byParagraph !== 'object' ||
    Array.isArray(byParagraph)
  )
    return {};
  const value = (byParagraph as Record<string, unknown>)[
    String(paragraphIndex)
  ];
  const found: { before?: number; after?: number } = {};
  const visit = (item: unknown): void => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    const record = item as Record<string, unknown>;
    const before = record.before ?? record.tokensBefore ?? record.tokens_before;
    const after = record.after ?? record.tokensAfter ?? record.tokens_after;
    if (typeof before === 'number' && Number.isFinite(before))
      found.before = (found.before ?? 0) + before;
    if (typeof after === 'number' && Number.isFinite(after))
      found.after = (found.after ?? 0) + after;
    Object.values(record).forEach(visit);
  };
  visit(value);
  return found;
}

function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function matchTypeLabel(value: string): string {
  return (
    (
      {
        EXACT_MATCH: 'Coincidencia exacta',
        NEAR_COPY: 'Copia cercana',
        PARAPHRASE_MATCH: 'Paráfrasis',
        SOURCE_MATCH: 'Coincidencia de fuente',
        RELATED_NOT_COUNTED: 'Relacionado, no contabilizado',
        EXCLUDED: 'Excluido',
      } as Record<string, string>
    )[value] ?? 'Tipo no especificado'
  );
}
