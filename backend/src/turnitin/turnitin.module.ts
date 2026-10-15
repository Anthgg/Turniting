import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TurnitinController } from './turnitin.controller.js';
import { TurnitinReportFileInterceptor } from './turnitin-report-file.interceptor.js';
import { TurnitinService } from './turnitin.service.js';

@Module({
  imports: [AiModule, DocumentsModule, PrismaModule],
  controllers: [TurnitinController],
  providers: [TurnitinService, TurnitinReportFileInterceptor],
})
export class TurnitinModule {}
