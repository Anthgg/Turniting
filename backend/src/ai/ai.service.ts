import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiAuthService } from './ai-auth.service.js';

type AiHealthResponse = { status: 'ok'; service: 'ai-service' };
export type AiTestAnalysisResponse = { status: 'ok'; characters: number; words: number };
export type AiExtractResponse = {
  status: 'success';
  fileType: 'pdf' | 'docx' | 'txt' | 'png' | 'jpeg';
  text: string;
  pageCount: number | null;
  wordCount: number;
  characterCount: number;
  requiresOcr: boolean;
  warnings: string[];
  pages: AiExtractPage[];
};

export type AiExtractPage = {
  pageNumber: number;
  classification: 'DIGITAL_OK' | 'OCR_REQUIRED' | 'HYBRID_CANDIDATE' | 'BLANK' | 'UNREADABLE';
  width: number;
  height: number;
  rotation: number;
  digitalText: string;
  canonicalText: string;
  extractionMethod: 'DIGITAL' | 'OCR' | 'HYBRID' | 'NONE';
  requiresOcr: boolean;
  imageAreaRatio: number;
  warnings: string[];
};

export type AiOcrBlock = {
  text: string;
  confidence: number | null;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  readingOrder: number;
  lowConfidence: boolean;
  duplicateOfDigital: boolean;
};

export type AiOcrPage = AiExtractPage & {
  ocrText: string | null;
  confidence: number | null;
  blocks: AiOcrBlock[];
  deskewAngle: number;
  processingMs: number;
  ocrErrorCode: string | null;
};

export type AiOcrProcessResponse = {
  status: 'success';
  engine: string;
  engineVersion: string;
  model: string;
  language: string;
  pipelineVersion: string;
  pages: AiOcrPage[];
  pagesRequested: number;
  pagesProcessed: number;
  pagesSkipped: number;
  pagesFailed: number;
  averageConfidence: number | null;
  durationMs: number;
  warnings: string[];
};

export type AiDocumentFile = {
  buffer: Buffer;
  mimeType: string;
  originalName: string;
};

export type AiTurnitinPercentage = {
  raw: string;
  percentage: number | null;
  percentageIsLessThan: boolean;
};

export type AiTurnitinSource = {
  sourceIndex: number;
  sourceType: 'INTERNET' | 'PUBLICATION' | 'STUDENT_PAPER' | 'OTHER';
  displayName: string;
  percentageRaw: string | null;
  percentage: number | null;
  percentageIsLessThan: boolean;
  color: string | null;
};

export type AiTurnitinSegment = {
  segmentIndex: number;
  segmentType: 'AI_FLAGGED' | 'SIMILARITY_MATCH' | 'NOT_FLAGGED' | 'UNKNOWN';
  pageNumber: number;
  text: string;
  normalizedText: string;
  bbox: [number, number, number, number];
  sourceIndex: number | null;
  color: string | null;
};

export type AiTurnitinParseResponse = {
  status: 'PARSED' | 'PARTIAL' | 'OCR_REQUIRED';
  reportType: 'AI_WRITING' | 'SIMILARITY' | 'UNKNOWN';
  parserVersion: string;
  metadata: Record<string, unknown>;
  scores: Record<string, AiTurnitinPercentage>;
  filters: string[];
  sources: AiTurnitinSource[];
  segments: AiTurnitinSegment[];
  warnings: string[];
  documentText: string;
};

export type AiTurnitinAlignmentResponse = {
  matchStatus: 'UNVERIFIED' | 'EXACT' | 'HIGH' | 'PARTIAL' | 'MISMATCH';
  similarityRatio: number | null;
  method: string;
  matchedChars: number;
  documentCharacterCount: number;
  reportCharacterCount: number;
  signals: string[];
  segmentAlignments: Array<{
    segmentIndex: number;
    documentStartOffset: number | null;
    documentEndOffset: number | null;
    alignmentMethod: string;
    alignmentScore: number | null;
  }>;
  warnings: string[];
};

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly ocrTimeoutMs: number;
  private readonly authMode: 'none' | 'google-id-token';

  constructor(
    private readonly config: ConfigService,
    private readonly auth: AiAuthService,
  ) {
    this.baseUrl = this.config.getOrThrow<string>('AI_SERVICE_URL').replace(/\/$/, '');
    this.timeoutMs = this.config.getOrThrow<number>('AI_SERVICE_TIMEOUT_MS');
    this.ocrTimeoutMs = this.config.get<number>('AI_OCR_TIMEOUT_MS') ?? 180000;
    this.authMode = this.config.getOrThrow<'none' | 'google-id-token'>('AI_SERVICE_AUTH_MODE');
  }

  async checkHealth(): Promise<AiHealthResponse> {
    const response = await this.request<AiHealthResponse>('/health');
    if (response.status !== 'ok' || response.service !== 'ai-service') {
      throw this.unavailable();
    }
    return response;
  }

  async analyzeTest(text: string): Promise<AiTestAnalysisResponse> {
    const response = await this.request<AiTestAnalysisResponse>('/analyze/test', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    if (
      response.status !== 'ok' ||
      typeof response.characters !== 'number' ||
      typeof response.words !== 'number'
    ) {
      throw this.unavailable();
    }
    return response;
  }

  async extractDocument(file: AiDocumentFile): Promise<AiExtractResponse> {
    const form = new FormData();
    form.append(
      'file',
      new Blob([Uint8Array.from(file.buffer)], { type: file.mimeType }),
      file.originalName,
    );
    const response = await this.request<AiExtractResponse>('/extract', {
      method: 'POST',
      body: form,
    });
    if (
      !response ||
      typeof response !== 'object' ||
      response.status !== 'success' ||
      !['pdf', 'docx', 'txt', 'png', 'jpeg'].includes(response.fileType) ||
      typeof response.text !== 'string' ||
      !(response.pageCount === null || (Number.isInteger(response.pageCount) && response.pageCount >= 0)) ||
      !Number.isInteger(response.wordCount) ||
      response.wordCount < 0 ||
      !Number.isInteger(response.characterCount) ||
      response.characterCount < 0 ||
      typeof response.requiresOcr !== 'boolean' ||
      !Array.isArray(response.warnings) ||
      response.warnings.some((warning) => typeof warning !== 'string') ||
      !Array.isArray(response.pages) ||
      response.pages.some((page) => !isAiExtractPage(page))
    ) {
      throw this.unavailable();
    }
    return response;
  }

  async processDocumentOcr(
    file: AiDocumentFile,
    options: { pages?: number[]; force?: boolean } = {},
  ): Promise<AiOcrProcessResponse> {
    const form = new FormData();
    form.append(
      'file',
      new Blob([Uint8Array.from(file.buffer)], { type: file.mimeType }),
      file.originalName,
    );
    if (options.pages) form.append('pages', JSON.stringify(options.pages));
    form.append('force', String(options.force ?? false));
    const response = await this.request<AiOcrProcessResponse>(
      '/ocr/process',
      { method: 'POST', body: form },
      this.ocrTimeoutMs,
    );
    if (
      !response ||
      response.status !== 'success' ||
      response.engine !== 'paddleocr' ||
      typeof response.engineVersion !== 'string' ||
      typeof response.model !== 'string' ||
      typeof response.language !== 'string' ||
      typeof response.pipelineVersion !== 'string' ||
      !Array.isArray(response.pages) ||
      !Number.isInteger(response.pagesRequested) ||
      !Number.isInteger(response.pagesProcessed) ||
      !Number.isInteger(response.pagesSkipped) ||
      !Number.isInteger(response.pagesFailed) ||
      !Array.isArray(response.warnings)
    ) {
      throw this.unavailable();
    }
    return response;
  }

  async parseTurnitinReport(file: AiDocumentFile): Promise<AiTurnitinParseResponse> {
    const form = new FormData();
    form.append(
      'file',
      new Blob([Uint8Array.from(file.buffer)], { type: file.mimeType }),
      file.originalName,
    );
    const response = await this.request<AiTurnitinParseResponse>('/turnitin/parse', {
      method: 'POST',
      body: form,
    });
    if (
      !response ||
      !['PARSED', 'PARTIAL', 'OCR_REQUIRED'].includes(response.status) ||
      !['AI_WRITING', 'SIMILARITY', 'UNKNOWN'].includes(response.reportType) ||
      typeof response.parserVersion !== 'string' ||
      typeof response.metadata !== 'object' ||
      response.metadata === null ||
      typeof response.scores !== 'object' ||
      response.scores === null ||
      !Array.isArray(response.filters) ||
      !Array.isArray(response.sources) ||
      !Array.isArray(response.segments) ||
      !Array.isArray(response.warnings) ||
      typeof response.documentText !== 'string'
    ) {
      throw this.unavailable();
    }
    return response;
  }

  async parseTurnitinOcrText(pages: string[]): Promise<AiTurnitinParseResponse> {
    const response = await this.request<AiTurnitinParseResponse>(
      '/turnitin/parse-ocr-text',
      {
        method: 'POST',
        body: JSON.stringify({ pages }),
      },
      this.ocrTimeoutMs,
    );
    if (
      !response ||
      !['PARSED', 'PARTIAL', 'OCR_REQUIRED'].includes(response.status) ||
      !['AI_WRITING', 'SIMILARITY', 'UNKNOWN'].includes(response.reportType) ||
      typeof response.parserVersion !== 'string' ||
      typeof response.metadata !== 'object' ||
      response.metadata === null ||
      typeof response.scores !== 'object' ||
      response.scores === null ||
      !Array.isArray(response.filters) ||
      !Array.isArray(response.sources) ||
      !Array.isArray(response.segments) ||
      !Array.isArray(response.warnings) ||
      typeof response.documentText !== 'string'
    ) {
      throw this.unavailable();
    }
    return response;
  }

  async alignTurnitinReport(
    documentText: string,
    reportText: string,
    segments: Array<Pick<AiTurnitinSegment, 'segmentIndex' | 'text'>>,
    documentMetadata: Record<string, unknown> = {},
    reportMetadata: Record<string, unknown> = {},
  ): Promise<AiTurnitinAlignmentResponse> {
    const response = await this.request<AiTurnitinAlignmentResponse>('/turnitin/align', {
      method: 'POST',
      body: JSON.stringify({
        documentText,
        reportText,
        segments,
        documentMetadata,
        reportMetadata,
      }),
    });
    if (
      !response ||
      !['UNVERIFIED', 'EXACT', 'HIGH', 'PARTIAL', 'MISMATCH'].includes(response.matchStatus) ||
      typeof response.method !== 'string' ||
      !Array.isArray(response.segmentAlignments) ||
      !Array.isArray(response.signals) ||
      !Array.isArray(response.warnings)
    ) {
      throw this.unavailable();
    }
    return response;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    requestTimeoutMs = this.timeoutMs,
  ): Promise<T> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('AI request timeout'));
      }, requestTimeoutMs);
    });

    const requestPromise = this.send<T>(path, init, controller.signal);
    try {
      return await Promise.race([requestPromise, timeoutPromise]);
    } catch (error) {
      const errorType = error instanceof Error ? error.name : 'UnknownError';
      this.logger.warn(JSON.stringify({ event: 'ai_request_failed', errorType }));
      throw this.unavailable();
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async send<T>(path: string, init: RequestInit, signal: AbortSignal): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (init.body && !(init.body instanceof FormData)) headers.set('content-type', 'application/json');

    if (this.authMode === 'google-id-token') {
      const authHeaders = await this.auth.getIdTokenHeaders(this.baseUrl);
      for (const [name, value] of Object.entries(authHeaders)) headers.set(name, value);
    }

    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal });
    if (!response.ok) {
      throw new Error('AI service returned a non-success response');
    }
    return (await response.json()) as T;
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException('AI service is unavailable');
  }
}

function isAiExtractPage(value: unknown): value is AiExtractPage {
  if (!value || typeof value !== 'object') return false;
  const page = value as Partial<AiExtractPage>;
  return (
    Number.isInteger(page.pageNumber) &&
    (page.pageNumber ?? 0) > 0 &&
    typeof page.classification === 'string' &&
    typeof page.width === 'number' &&
    Number.isFinite(page.width) &&
    typeof page.height === 'number' &&
    Number.isFinite(page.height) &&
    Number.isInteger(page.rotation) &&
    typeof page.digitalText === 'string' &&
    typeof page.canonicalText === 'string' &&
    typeof page.requiresOcr === 'boolean' &&
    typeof page.imageAreaRatio === 'number' &&
    Number.isFinite(page.imageAreaRatio) &&
    Array.isArray(page.warnings) &&
    ['DIGITAL', 'OCR', 'HYBRID', 'NONE'].includes(page.extractionMethod ?? '')
  );
}
