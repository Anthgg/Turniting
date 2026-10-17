import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { DatasetRepository } from './dataset.repository.js';
import { DatasetService } from './dataset.service.js';
import { DatasetsController, ModelVersionsController } from './datasets.controller.js';
import { GroundTruthDatasetService } from './ground-truth-dataset.service.js';
import { ModelVersionService } from './model-version.service.js';
import { TrainingFilesService } from './training-files.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [DatasetsController, ModelVersionsController],
  providers: [DatasetRepository, DatasetService, GroundTruthDatasetService, ModelVersionService, TrainingFilesService],
})
export class DatasetsModule {}
