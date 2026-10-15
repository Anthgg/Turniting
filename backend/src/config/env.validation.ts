export type Environment = {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  DATABASE_URL: string;
  DIRECT_URL: string;
  AI_SERVICE_URL: string;
  AI_SERVICE_TIMEOUT_MS: number;
  AI_SERVICE_AUTH_MODE: 'none' | 'google-id-token';
  CORS_ORIGINS: string;
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
    throw new Error('Configuration validation failed: CORS_ORIGINS must contain explicit origins and cannot use wildcards');
  }

  for (const origin of origins) {
    try {
      const parsed = new URL(origin);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
        throw new Error('invalid');
      }
    } catch {
      throw new Error('Configuration validation failed: CORS_ORIGINS must contain valid origins');
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
    requiredString(config.CORS_ORIGINS ?? 'http://localhost:5173', 'CORS_ORIGINS'),
    nodeEnv,
  );

  return {
    ...config,
    NODE_ENV: nodeEnv,
    PORT: parseInteger(config.PORT, 'PORT', 3000, 1, 65535),
    DATABASE_URL: databaseUrl,
    DIRECT_URL: directUrl,
    AI_SERVICE_URL: aiUrl.toString().replace(/\/$/, ''),
    AI_SERVICE_TIMEOUT_MS: parseInteger(config.AI_SERVICE_TIMEOUT_MS, 'AI_SERVICE_TIMEOUT_MS', 3000, 100, 30000),
    AI_SERVICE_AUTH_MODE: authMode,
    CORS_ORIGINS: corsOrigins,
  };
}
