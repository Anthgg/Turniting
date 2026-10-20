import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AnalysisService } from './analysis.service.js';
import { AnalysisSegmentsQueryDto, AnalyzeDocumentDto, CompareAnalysesDto } from './dto/analysis.dto.js';
import { AnalyzerModelsService } from './models.service.js';

@ApiTags('analysis')
@Controller()
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

  @Post('documents/:id/analyze')
  @ApiOperation({ summary: 'Run the local AI analyzer on the document text (independent AI signal, not a Turnitin score)' })
  analyze(@Param('id', ParseUUIDPipe) id: string, @Body() body: AnalyzeDocumentDto) {
    return this.analysis.analyzeDocument(id, body);
  }

  @Get('documents/:id/analyses')
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.analysis.listForDocument(id);
  }

  @Get('analyses/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.analysis.getRun(id);
  }

  @Get('analyses/:id/segments')
  segments(@Param('id', ParseUUIDPipe) id: string, @Query() query: AnalysisSegmentsQueryDto) {
    return this.analysis.getSegments(id, query);
  }

  @Get('analyses/:id/technical-presentation')
  @ApiOperation({ summary: 'Read-only grouped presentation of the persisted analysis segments' })
  presentation(@Param('id', ParseUUIDPipe) id: string) {
    return this.analysis.getTechnicalPresentation(id);
  }

  @Get('analyses/:id/segments/:segmentId/context')
  context(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('segmentId', ParseUUIDPipe) segmentId: string,
  ) {
    return this.analysis.getSegmentContext(id, segmentId);
  }

  @Post('analyses/compare')
  compare(@Body() body: CompareAnalysesDto) {
    return this.analysis.compare(body);
  }
}

@ApiTags('analysis')
@Controller('models')
export class AnalyzerModelsController {
  constructor(private readonly models: AnalyzerModelsService) {}

  @Get()
  @ApiOperation({ summary: 'Registered analyzer models with live artifact availability' })
  list() {
    return this.models.list();
  }

  @Get(':id/metrics')
  metrics(@Param('id') id: string) {
    return this.models.metrics(id);
  }

  @Post('import-v3-registry')
  @ApiOperation({ summary: 'Register CANDIDATE_MODEL_V3 metadata from training/datasets/manifests/model_registry_v3.json' })
  importV3() {
    return this.models.importV3Registry();
  }
}
