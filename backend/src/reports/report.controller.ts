import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  StreamableFile,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  GenerateAIReportDto,
  GenerateSimilarityReportDto,
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
    return this.reports.generateAI(documentId, body.analysisRunId);
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
  listForDocument(@Param('documentId', ParseUUIDPipe) documentId: string) {
    return this.reports.listForDocument(documentId);
  }

  @Get('reports/:reportId')
  get(@Param('reportId', ParseUUIDPipe) reportId: string) {
    return this.reports.get(reportId);
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

  @Delete('reports/:reportId')
  @HttpCode(204)
  async delete(
    @Param('reportId', ParseUUIDPipe) reportId: string,
  ): Promise<void> {
    await this.reports.delete(reportId);
  }
}
