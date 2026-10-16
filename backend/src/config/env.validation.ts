export type Environment = {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  DATABASE_URL: string;
  DIRECT_URL: string;
  AI_SERVICE_URL: string;
  AI_SERVICE_TIMEOUT_MS: number;
  AI_OCR_TIMEOUT_MS: number;
  AI_SERVICE_AUTH_MODE: 'none' | 'google-id-token';
  CORS_ORIGIN: string;
  UPLOAD_DIR: string;
  MAX_UPLOAD_MB: number;
  MAX_TURNITIN_REPORT_MB: number;
  OCR_ENGINE: 'paddleocr';
  OCR_ENGINE_VERSION: string;
  OCR_LANGUAGE: string;
  OCR_MODEL: string;
  OCR_PIPELINE_VERSION: string;
  OCR_DPI: number;
  OCR_TIMEOUT_MS: number;
  OCR_MAX_PAGES_PER_RUN: number;
  OCR_MAX_RENDER_PIXELS: number;
  OCR_LOW_CONFIDENCE_THRESHOLD: number;
  OCR_MAX_CONCURRENT_JOBS: number;
  OCR_MIN_DIGITAL_CHARS: number;
  OCR_MIN_DIGITAL_WORDS: number;
  OCR_IMAGE_AREA_RATIO: number;
  OCR_BLANK_PAGE_THRESHOLD: number;
  OCR_DESKEW_MIN_ANGLE: number;
  OCR_CONTRAST_RANGE: number;
};

function requiredString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Configuration validation failed: ${key} is required`);
  }
  return value.trim();
}

function parseInteger(value: unknown, key: string, fallback: number, min: number, max: number): number {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Configuration validation failed: ${key} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function parseDecimal(value: unknown, key: string, fallback: number, min: number, max: number): number {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Configuration validation failed: ${key} must be from ${min} to ${max}`);
  }
  return parsed;
}

function validateDatabaseUrl(value: string, key: string): string {
  try {
    const parsed = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error('invalid');
    }
  } catch {
    throw new Error(`Configuration validation failed: ${key} must be a PostgreSQL connection URL`);
  }
  return value;
}

function validateServiceUrl(value: string, key: string): URL {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
      throw new Error('invalid');
    }
    return parsed;
  } catch {
    throw new Error(`Configuration validation failed: ${key} must be an HTTP(S) URL without credentials`);
  }
}

function validateCorsOrigins(value: string, nodeEnv: Environment['NODE_ENV']): string {
  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0 || origins.some((origin) => origin === '*' || origin.includes('*'))) {
    throw new Error('Configuration validation failed: CORS_ORIGIN must contain explicit origins and cannot use wildcards');
  }

  for (const origin of origins) {
    try {
      const parsed = new URL(origin);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
        throw new Error('invalid');
      }
    } catch {
      throw new Error('Configuration validation failed: CORS_ORIGIN must contain valid origins');
    }
  }

  if (nodeEnv === 'production' && origins.includes('*')) {
    throw new Error('Configuration validation failed: wildcard CORS is not allowed in production');
  }
  return origins.join(',');
}

export function validateEnvironment(config: Record<string, unknown>): Environment {
  const nodeEnv = (config.NODE_ENV ?? 'development') as Environment['NODE_ENV'];
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('Configuration validation failed: NODE_ENV must be development, test, or production');
  }

  const databaseUrl = validateDatabaseUrl(requiredString(config.DATABASE_URL, 'DATABASE_URL'), 'DATABASE_URL');
  const directUrl = validateDatabaseUrl(requiredString(config.DIRECT_URL, 'DIRECT_URL'), 'DIRECT_URL');
  const aiUrl = validateServiceUrl(requiredString(config.AI_SERVICE_URL, 'AI_SERVICE_URL'), 'AI_SERVICE_URL');
  const authMode = (config.AI_SERVICE_AUTH_MODE ?? 'none') as Environment['AI_SERVICE_AUTH_MODE'];
  if (!['none', 'google-id-token'].includes(authMode)) {
    throw new Error('Configuration validation failed: AI_SERVICE_AUTH_MODE must be none or google-id-token');
  }
  if (nodeEnv === 'production' && authMode === 'google-id-token' && aiUrl.protocol !== 'https:') {
    throw new Error('Configuration validation failed: AI_SERVICE_URL must use HTTPS when Google ID token auth is enabled');
  }

  const corsOrigins = validateCorsOrigins(
    requiredString(config.CORS_ORIGIN ?? 'http://localhost:5173', 'CORS_ORIGIN'),
    nodeEnv,
  );
  const ocrEngine = (config.OCR_ENGINE ?? 'paddleocr') as Environment['OCR_ENGINE'];
  if (ocrEngine !== 'paddleocr') {
    throw new Error('Configuration validation failed: OCR_ENGINE must be paddleocr');
  }

  return {
    ...config,
    NODE_ENV: nodeEnv,
    PORT: parseInteger(config.PORT, 'PORT', 3000, 1, 65535),
    DATABASE_URL: databaseUrl,
    DIRECT_URL: directUrl,
    AI_SERVICE_URL: aiUrl.toString().replace(/\/$/, ''),
    AI_SERVICE_TIMEOUT_MS: parseInteger(config.AI_SERVICE_TIMEOUT_MS, 'AI_SERVICE_TIMEOUT_MS', 30000, 100, 30000),
    AI_OCR_TIMEOUT_MS: parseInteger(config.AI_OCR_TIMEOUT_MS, 'AI_OCR_TIMEOUT_MS', 180000, 1000, 600000),
    AI_SERVICE_AUTH_MODE: authMode,
    CORS_ORIGIN: corsOrigins,
    UPLOAD_DIR: requiredString(config.UPLOAD_DIR ?? '/data/uploads', 'UPLOAD_DIR'),
    MAX_UPLOAD_MB: parseInteger(config.MAX_UPLOAD_MB, 'MAX_UPLOAD_MB', 20, 1, 100),
    MAX_TURNITIN_REPORT_MB: parseInteger(config.MAX_TURNITIN_REPORT_MB, 'MAX_TURNITIN_REPORT_MB', 30, 1, 100),
    OCR_ENGINE: ocrEngine,
    OCR_ENGINE_VERSION: requiredString(config.OCR_ENGINE_VERSION ?? '3.7.0', 'OCR_ENGINE_VERSION'),
    OCR_LANGUAGE: requiredString(config.OCR_LANGUAGE ?? 'es', 'OCR_LANGUAGE'),
    OCR_MODEL: requiredString(
      config.OCR_MODEL ??
        'PP-OCRv5_mobile_det+latin_PP-OCRv5_mobile_rec',
      'OCR_MODEL',
    ),
    OCR_PIPELINE_VERSION: requiredString(config.OCR_PIPELINE_VERSION ?? 'f003-v1', 'OCR_PIPELINE_VERSION'),
    OCR_DPI: parseInteger(config.OCR_DPI, 'OCR_DPI', 220, 72, 400),
    OCR_TIMEOUT_MS: parseInteger(config.OCR_TIMEOUT_MS, 'OCR_TIMEOUT_MS', 120000, 1000, 600000),
    OCR_MAX_PAGES_PER_RUN: parseInteger(config.OCR_MAX_PAGES_PER_RUN, 'OCR_MAX_PAGES_PER_RUN', 150, 1, 1000),
    OCR_MAX_RENDER_PIXELS: parseInteger(config.OCR_MAX_RENDER_PIXELS, 'OCR_MAX_RENDER_PIXELS', 20000000, 100000, 100000000),
    OCR_LOW_CONFIDENCE_THRESHOLD: parseDecimal(config.OCR_LOW_CONFIDENCE_THRESHOLD, 'OCR_LOW_CONFIDENCE_THRESHOLD', 0.6, 0, 1),
    OCR_MAX_CONCURRENT_JOBS: parseInteger(config.OCR_MAX_CONCURRENT_JOBS, 'OCR_MAX_CONCURRENT_JOBS', 1, 1, 8),
    OCR_MIN_DIGITAL_CHARS: parseInteger(config.OCR_MIN_DIGITAL_CHARS, 'OCR_MIN_DIGITAL_CHARS', 20, 1, 100000),
    OCR_MIN_DIGITAL_WORDS: parseInteger(config.OCR_MIN_DIGITAL_WORDS, 'OCR_MIN_DIGITAL_WORDS', 4, 1, 10000),
    OCR_IMAGE_AREA_RATIO: parseDecimal(config.OCR_IMAGE_AREA_RATIO, 'OCR_IMAGE_AREA_RATIO', 0.15, 0, 1),
    OCR_BLANK_PAGE_THRESHOLD: parseDecimal(config.OCR_BLANK_PAGE_THRESHOLD, 'OCR_BLANK_PAGE_THRESHOLD', 0.004, 0, 1),
    OCR_DESKEW_MIN_ANGLE: parseDecimal(config.OCR_DESKEW_MIN_ANGLE, 'OCR_DESKEW_MIN_ANGLE', 1, 0, 10),
    OCR_CONTRAST_RANGE: parseInteger(config.OCR_CONTRAST_RANGE, 'OCR_CONTRAST_RANGE', 70, 1, 255),
  };
}
