import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  GenerateAIReportDto,
  GenerateSimilarityReportDto,
  ListReportsDto,
} from './report.dto.js';
import { ReportService } from './report.service.js';

@ApiTags('reports')
@Controller()
export class ReportController {
  constructor(private readonly reports: ReportService) {}

  @Post('documents/:documentId/reports/ai')
  @ApiOperation({
    summary:
      'Generate or reuse an expiring AI report for a completed analysis run',
  })
  generateAI(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() body: GenerateAIReportDto,
  ) {
    return this.reports.generateAI(
      documentId,
      body.analysisRunId,
      undefined,
      body.variant,
    );
  }

  @Post('documents/:documentId/reports/similarity')
  @ApiOperation({
    summary:
      'Request a similarity report when a persisted F008 run is available',
  })
  generateSimilarity(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() body: GenerateSimilarityReportDto,
  ) {
    return this.reports.generateSimilarity(documentId, body.similarityRunId);
  }

  @Get('documents/:documentId/reports')
  listForDocument(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Query() query: ListReportsDto,
  ) {
    return this.reports.listForDocument(documentId, query);
  }

  @Get('reports')
  list(@Query() query: ListReportsDto) {
    return this.reports.list(query);
  }

  @Get('reports/:reportId')
  get(@Param('reportId', ParseUUIDPipe) reportId: string) {
    return this.reports.get(reportId);
  }

  @Post('reports/:reportId/regenerate')
  regenerate(@Param('reportId', ParseUUIDPipe) reportId: string) {
    return this.reports.regenerate(reportId);
  }

  @Get('reports/:reportId/download')
  @ApiOperation({ summary: 'Download an available report PDF' })
  async download(
    @Param('reportId', ParseUUIDPipe) reportId: string,
  ): Promise<StreamableFile> {
    const { metadata, buffer } = await this.reports.download(reportId);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${metadata.filename}"`,
      length: buffer.length,
    });
  }

  @Get('reports/:reportId/preview')
  @ApiOperation({ summary: 'Preview an available report PDF inline' })
  async preview(
    @Param('reportId', ParseUUIDPipe) reportId: string,
  ): Promise<StreamableFile> {
    const { metadata, buffer } = await this.reports.preview(reportId);
    const filename = metadata.filename.replace(/[\r\n"]/gu, '');
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `inline; filename="${filename}"`,
      length: buffer.length,
    });
  }

  @Delete('reports/:reportId')
  @HttpCode(204)
  async delete(
    @Param('reportId', ParseUUIDPipe) reportId: string,
  ): Promise<void> {
    await this.reports.delete(reportId);
  }
}
