import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { AiService } from '../ai/ai.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
  ) {}

  getHealth(): { status: 'ok'; service: 'backend' } {
    return { status: 'ok', service: 'backend' };
  }

  async getDatabaseHealth(): Promise<{ status: 'ok'; database: 'connected' }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'connected' };
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'database_health_failed',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      throw new ServiceUnavailableException('Database is unavailable');
    }
  }

  async getAiHealth(): Promise<{ status: 'ok'; aiService: 'connected' }> {
    await this.aiService.checkHealth();
    return { status: 'ok', aiService: 'connected' };
  }
}
