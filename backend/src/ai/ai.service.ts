import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiAuthService } from './ai-auth.service.js';

type AiHealthResponse = { status: 'ok'; service: 'ai-service' };
export type AiTestAnalysisResponse = { status: 'ok'; characters: number; words: number };
export type AiExtractResponse = {
  status: 'success';
  fileType: 'pdf' | 'docx' | 'txt';
  text: string;
  pageCount: number | null;
  wordCount: number;
  characterCount: number;
  requiresOcr: boolean;
  warnings: string[];
};

export type AiDocumentFile = {
  buffer: Buffer;
  mimeType: string;
  originalName: string;
};

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly authMode: 'none' | 'google-id-token';

  constructor(
    private readonly config: ConfigService,
    private readonly auth: AiAuthService,
  ) {
    this.baseUrl = this.config.getOrThrow<string>('AI_SERVICE_URL').replace(/\/$/, '');
    this.timeoutMs = this.config.getOrThrow<number>('AI_SERVICE_TIMEOUT_MS');
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
      !['pdf', 'docx', 'txt'].includes(response.fileType) ||
      typeof response.text !== 'string' ||
      !(response.pageCount === null || (Number.isInteger(response.pageCount) && response.pageCount >= 0)) ||
      !Number.isInteger(response.wordCount) ||
      response.wordCount < 0 ||
      !Number.isInteger(response.characterCount) ||
      response.characterCount < 0 ||
      typeof response.requiresOcr !== 'boolean' ||
      !Array.isArray(response.warnings) ||
      response.warnings.some((warning) => typeof warning !== 'string')
    ) {
      throw this.unavailable();
    }
    return response;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('AI request timeout'));
      }, this.timeoutMs);
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
