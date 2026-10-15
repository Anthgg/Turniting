process.env.NODE_ENV ??= 'test';
process.env.PORT ??= '3000';
process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/turniting_test?schema=public';
process.env.DIRECT_URL ??= process.env.DATABASE_URL;
process.env.AI_SERVICE_URL ??= 'http://127.0.0.1:8000';
process.env.AI_SERVICE_TIMEOUT_MS ??= '1000';
process.env.AI_SERVICE_AUTH_MODE ??= 'none';
process.env.CORS_ORIGINS ??= 'http://localhost:5173';
