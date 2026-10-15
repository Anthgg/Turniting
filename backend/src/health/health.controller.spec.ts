import { describe, expect, it, vi } from 'vitest';
import { HealthService } from './health.service.js';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  const healthService = {
    getHealth: vi.fn().mockReturnValue({ status: 'ok', service: 'backend' }),
    getDatabaseHealth: vi.fn().mockResolvedValue({ status: 'ok', database: 'connected' }),
    getAiHealth: vi.fn().mockResolvedValue({ status: 'ok', aiService: 'connected' }),
  };
  const controller = new HealthController(healthService as unknown as HealthService);

  it('delegates the backend health endpoint', () => {
    expect(controller.getHealth()).toEqual({ status: 'ok', service: 'backend' });
    expect(healthService.getHealth).toHaveBeenCalled();
  });

  it('delegates database and AI health checks', async () => {
    await expect(controller.getDatabaseHealth()).resolves.toEqual({ status: 'ok', database: 'connected' });
    await expect(controller.getAiHealth()).resolves.toEqual({ status: 'ok', aiService: 'connected' });
    expect(healthService.getDatabaseHealth).toHaveBeenCalled();
    expect(healthService.getAiHealth).toHaveBeenCalled();
  });
});
