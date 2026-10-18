import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiModule } from './ai/ai.module.js';
import { AnalysisModule } from './analysis/analysis.module.js';
import { validateEnvironment } from './config/env.validation.js';
import { DatasetsModule } from './datasets/datasets.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { TurnitinModule } from './turnitin/turnitin.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),
    PrismaModule,
    AiModule,
    DocumentsModule,
    HealthModule,
    TurnitinModule,
    DatasetsModule,
    AnalysisModule,
    ReportsModule,
  ],
})
export class AppModule {}
