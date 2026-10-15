import { Module } from '@nestjs/common';
import { AiAuthService } from './ai-auth.service.js';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';

@Module({
  controllers: [AiController],
  providers: [AiAuthService, AiService],
  exports: [AiService],
})
export class AiModule {}
