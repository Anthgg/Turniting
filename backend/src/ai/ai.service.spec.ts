import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiAuthService } from './ai-auth.service.js';
import { AiService } from './ai.service.js';

const makeConfig = (authMode: 'none' | 'google-id-token' = 'none', timeoutMs = 500) =>
  ({
    getOrThrow: (key: string) =>
      ({
        AI_SERVICE_URL: 'http://ai-service:8000',
        AI_SERVICE_TIMEOUT_MS: timeoutMs,
        AI_SERVICE_AUTH_MODE: authMode,
      })[key],
  }) as unknown as ConfigService;

describe('AiService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('calls the AI health endpoint and validates its service identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok', service: 'ai-service' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new AiService(makeConfig(), new AiAuthService());

    await expect(service.checkHealth()).resolves.toEqual({ status: 'ok', service: 'ai-service' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://ai-service:8000/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('sends the test analysis request through the reusable client', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok', characters: 11, words: 2 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new AiService(makeConfig(), new AiAuthService());

    await expect(service.analyzeTest('hello world')).resolves.toEqual({
      status: 'ok',
      characters: 11,
      words: 2,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://ai-service:8000/analyze/test',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'hello world' }),
      }),
    );
  });

  it('adds a Google ID token header only when authentication is enabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok', service: 'ai-service' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const auth = { getIdTokenHeaders: vi.fn().mockResolvedValue({ authorization: 'Bearer test-token' }) };
    const service = new AiService(makeConfig('google-id-token'), auth as unknown as AiAuthService);

    await service.checkHealth();

    expect(auth.getIdTokenHeaders).toHaveBeenCalledWith('http://ai-service:8000');
    const requestOptions = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(requestOptions.headers).get('authorization')).toBe('Bearer test-token');
  });

  it('converts HTTP and timeout failures to a controlled 503', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('unavailable', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new AiService(makeConfig(), new AiAuthService());
    await expect(service.checkHealth()).rejects.toBeInstanceOf(ServiceUnavailableException);

    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(() => undefined)));
    const fastService = new AiService(makeConfig('none', 100), new AiAuthService());
    await expect(fastService.checkHealth()).rejects.toMatchObject({ status: 503 });
  });

  it('rejects a mismatched AI health payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 })));
    const service = new AiService(makeConfig(), new AiAuthService());
    await expect(service.checkHealth()).rejects.toMatchObject({ status: 503 });
  });
});
