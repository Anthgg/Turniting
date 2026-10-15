import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { HealthService } from './health.service.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Check backend availability' })
  @ApiResponse({ status: 200, description: 'Backend is available' })
  getHealth(): { status: 'ok'; service: 'backend' } {
    return this.healthService.getHealth();
  }

  @Get('db')
  @ApiOperation({ summary: 'Check PostgreSQL connectivity' })
  @ApiResponse({ status: 200, description: 'PostgreSQL is connected' })
  @ApiResponse({ status: 503, description: 'PostgreSQL is unavailable' })
  getDatabaseHealth(): Promise<{ status: 'ok'; database: 'connected' }> {
    return this.healthService.getDatabaseHealth();
  }

  @Get('ai')
  @ApiOperation({ summary: 'Check FastAPI connectivity' })
  @ApiResponse({ status: 200, description: 'AI service is connected' })
  @ApiResponse({ status: 503, description: 'AI service is unavailable' })
  getAiHealth(): Promise<{ status: 'ok'; aiService: 'connected' }> {
    return this.healthService.getAiHealth();
  }
}
