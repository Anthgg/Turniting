import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { DatasetsModule } from '../datasets/datasets.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AnalysisController, AnalyzerModelsController } from './analysis.controller.js';
import { AnalysisService } from './analysis.service.js';
import { AnalyzerModelsService } from './models.service.js';

@Module({
  imports: [PrismaModule, AiModule, DatasetsModule],
  controllers: [AnalysisController, AnalyzerModelsController],
  providers: [AnalysisService, AnalyzerModelsService],
})
export class AnalysisModule {}
