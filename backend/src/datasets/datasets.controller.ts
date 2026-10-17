import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DatasetService } from './dataset.service.js';
import {
  DatasetPaginationQueryDto,
  ImportManifestDto,
  ImportModelRegistryDto,
  ListTrainingSamplesQueryDto,
  RegisterDatasetDto,
  RegisterModelVersionDto,
} from './dto/datasets.dto.js';
import { GroundTruthDatasetService } from './ground-truth-dataset.service.js';
import { ModelVersionService } from './model-version.service.js';

@ApiTags('datasets')
@Controller('datasets')
export class DatasetsController {
  constructor(
    private readonly datasets: DatasetService,
    private readonly groundTruth: GroundTruthDatasetService,
    private readonly models: ModelVersionService,
  ) {}

  @Get()
  list(@Query() query: DatasetPaginationQueryDto) {
    return this.datasets.list(query.page, query.limit);
  }

  @Post('register')
  @ApiOperation({ summary: 'Register a dataset version (optionally importing its manifests from TRAINING_DIR)' })
  register(@Body() body: RegisterDatasetDto) {
    return this.datasets.register(body);
  }

  @Get(':id')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.datasets.getById(id);
  }

  @Get(':id/sources')
  getSources(@Param('id', ParseUUIDPipe) id: string) {
    return this.datasets.getSources(id);
  }

  @Get(':id/artifacts')
  getArtifacts(@Param('id', ParseUUIDPipe) id: string) {
    return this.datasets.getArtifacts(id);
  }

  @Get(':id/statistics')
  getStatistics(@Param('id', ParseUUIDPipe) id: string) {
    return this.datasets.getStatistics(id);
  }

  @Get(':id/samples')
  listSamples(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListTrainingSamplesQueryDto) {
    return this.datasets.listSamples(id, query);
  }

  @Get(':id/models')
  listModels(@Param('id', ParseUUIDPipe) id: string) {
    return this.models.list(id);
  }

  @Post(':id/import-manifest')
  @ApiOperation({ summary: 'Validate and import training manifests (metadata only; no Parquet rows)' })
  importManifest(@Param('id', ParseUUIDPipe) id: string, @Body() body: ImportManifestDto) {
    return this.datasets.importManifest(id, body);
  }

  @Post(':id/import-ground-truth/:caseId')
  @ApiOperation({ summary: 'Create MACHINE candidate samples from AI_FLAGGED segments (NOT_FLAGGED is never HUMAN)' })
  importGroundTruth(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
  ) {
    return this.groundTruth.importCase(id, caseId);
  }
}

@ApiTags('model-versions')
@Controller('model-versions')
export class ModelVersionsController {
  constructor(private readonly models: ModelVersionService) {}

  @Get()
  list() {
    return this.models.list();
  }

  @Get(':id')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.models.getById(id);
  }

  @Post('register')
  @ApiOperation({ summary: 'Register model metadata (never ACTIVE; weights are not uploaded)' })
  register(@Body() body: RegisterModelVersionDto) {
    return this.models.register(body);
  }

  @Post('import-registry')
  @ApiOperation({ summary: 'Import model_registry.json from TRAINING_DIR for a dataset version' })
  importRegistry(@Body() body: ImportModelRegistryDto) {
    return this.models.importRegistry(body);
  }
}
