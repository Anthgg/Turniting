import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ProcessOcrDto } from './dto/process-ocr.dto.js';
import { DocumentsService } from './documents.service.js';

@Controller('document-versions')
export class DocumentVersionsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post(':versionId/ocr')
  processOcr(
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() body: ProcessOcrDto = {},
  ) {
    return this.documents.processOcrForVersion(versionId, body);
  }

  @Get(':versionId/pages/:pageNumber')
  pageDetail(
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Param('pageNumber', ParseIntPipe) pageNumber: number,
  ) {
    return this.documents.getPageDetail(versionId, pageNumber);
  }

  @Get(':versionId/ocr-runs')
  ocrRuns(@Param('versionId', ParseUUIDPipe) versionId: string) {
    return this.documents.getOcrRuns(versionId);
  }
}
