import { ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiService } from '../ai/ai.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { HealthService } from './health.service.js';

describe('HealthService', () => {
  let prisma: { $queryRaw: ReturnType<typeof vi.fn> };
  let aiService: { checkHealth: ReturnType<typeof vi.fn> };
  let service: HealthService;

  beforeEach(() => {
    prisma = { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) };
    aiService = { checkHealth: vi.fn().mockResolvedValue({ status: 'ok', service: 'ai-service' }) };
    service = new HealthService(prisma as unknown as PrismaService, aiService as unknown as AiService);
  });

  it('returns backend process health without external calls', () => {
    expect(service.getHealth()).toEqual({ status: 'ok', service: 'backend' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(aiService.checkHealth).not.toHaveBeenCalled();
  });

  it('executes a real SQL health probe through Prisma', async () => {
    await expect(service.getDatabaseHealth()).resolves.toEqual({ status: 'ok', database: 'connected' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw.mock.calls[0]?.[0]).toEqual(['SELECT 1']);
  });

  it('returns a controlled unavailable error when PostgreSQL cannot be reached', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('private connection detail'));
    await expect(service.getDatabaseHealth()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.getDatabaseHealth()).rejects.not.toThrow('private connection detail');
  });

  it('calls the AI service health client and returns the public connection state', async () => {
    await expect(service.getAiHealth()).resolves.toEqual({ status: 'ok', aiService: 'connected' });
    expect(aiService.checkHealth).toHaveBeenCalledTimes(1);
  });
});
