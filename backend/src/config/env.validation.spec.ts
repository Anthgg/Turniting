import { describe, expect, it } from 'vitest';
import { validateEnvironment } from './env.validation.js';

const validEnvironment = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/turniting_test',
  DIRECT_URL: 'postgresql://test:test@localhost:5432/turniting_test',
  AI_SERVICE_URL: 'http://ai-service:8000',
};

describe('validateEnvironment', () => {
  it('applies safe defaults and parses numeric configuration', () => {
    const config = validateEnvironment(validEnvironment);
    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3000);
    expect(config.AI_SERVICE_TIMEOUT_MS).toBe(30000);
    expect(config.AI_SERVICE_AUTH_MODE).toBe('none');
    expect(config.CORS_ORIGIN).toBe('http://localhost:5173');
    expect(config.UPLOAD_DIR).toBe('/data/uploads');
    expect(config.MAX_UPLOAD_MB).toBe(20);
    expect(config.MAX_TURNITIN_REPORT_MB).toBe(30);
  });

  it('rejects a wildcard CORS origin in production', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        NODE_ENV: 'production',
        CORS_ORIGIN: '*',
      }),
    ).toThrow(/CORS_ORIGIN/);
  });

  it('requires HTTPS when Google identity token authentication is enabled in production', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        NODE_ENV: 'production',
        AI_SERVICE_AUTH_MODE: 'google-id-token',
        AI_SERVICE_URL: 'http://ai-service:8000',
      }),
    ).toThrow(/HTTPS/);
  });

  it('rejects missing database settings without echoing values', () => {
    expect(() => validateEnvironment({ AI_SERVICE_URL: 'http://ai-service:8000' })).toThrow(/DATABASE_URL is required/);
  });
});
