import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { BufferedUpload } from '../documents/file-validation.js';
import {
  CreateGroundTruthCaseDto,
  ListTurnitinReportsQueryDto,
  ListTurnitinSegmentsQueryDto,
  MatchDocumentVersionDto,
  PaginationQueryDto,
  UpdateGroundTruthCaseDto,
} from './dto/turnitin.dto.js';
import { TurnitinReportFileInterceptor } from './turnitin-report-file.interceptor.js';
import { TurnitinService } from './turnitin.service.js';

@ApiTags('turnitin-reports')
@Controller('turnitin')
export class TurnitinController {
  constructor(private readonly turnitin: TurnitinService) {}

  @Post('reports')
  @ApiOperation({ summary: 'Upload and parse a visible Turnitin PDF report' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(TurnitinReportFileInterceptor)
  upload(@UploadedFile() file?: BufferedUpload) {
    return this.turnitin.upload(file);
  }

  @Get('reports')
  list(@Query() query: ListTurnitinReportsQueryDto) {
    return this.turnitin.list(query);
  }

  @Get('reports/:id/sources')
  getSources(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.turnitin.getSources(id, query.page, query.limit);
  }

  @Get('reports/:id/segments')
  getSegments(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListTurnitinSegmentsQueryDto,
  ) {
    return this.turnitin.getSegments(id, query);
  }

  @Post('reports/:id/reparse')
  @ApiOperation({ summary: 'Reparse a stored report and replace parsed data atomically' })
  reparse(@Param('id', ParseUUIDPipe) id: string) {
    return this.turnitin.reparse(id);
  }

  @Post('reports/:id/ocr-reparse')
  @ApiOperation({ summary: 'Use local OCR to reparse a scanned Turnitin report' })
  ocrReparse(@Param('id', ParseUUIDPipe) id: string) {
    return this.turnitin.ocrReparse(id);
  }

  @Post('reports/:id/match')
  @ApiOperation({ summary: 'Align report text to an extracted document version' })
  match(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: MatchDocumentVersionDto,
  ) {
    return this.turnitin.match(id, body.documentVersionId);
  }

  @Get('reports/:id')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.turnitin.getById(id);
  }

  @Delete('reports/:id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.turnitin.remove(id);
  }

  @Post('ground-truth')
  @ApiOperation({ summary: 'Register a Turnitin parser ground truth case' })
  createGroundTruth(@Body() body: CreateGroundTruthCaseDto) {
    return this.turnitin.createGroundTruthCase(body);
  }

  @Get('ground-truth')
  listGroundTruth(@Query() query: PaginationQueryDto) {
    return this.turnitin.listGroundTruthCases(query.page, query.limit);
  }

  @Get('ground-truth/:id')
  getGroundTruth(@Param('id', ParseUUIDPipe) id: string) {
    return this.turnitin.getGroundTruthCase(id);
  }

  @Patch('ground-truth/:id')
  updateGroundTruth(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateGroundTruthCaseDto,
  ) {
    return this.turnitin.updateGroundTruthCase(id, body);
  }
}
