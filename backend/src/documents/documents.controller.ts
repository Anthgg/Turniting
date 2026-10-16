import {
  Controller,
  Body,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { BufferedUpload } from './file-validation.js';
import { DocumentFileInterceptor } from './document-file.interceptor.js';
import { DocumentsService } from './documents.service.js';
import { ListDocumentsQueryDto } from './dto/list-documents-query.dto.js';
import { ProcessOcrDto } from './dto/process-ocr.dto.js';

@ApiTags('documents')
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post()
  @ApiOperation({
    summary: 'Upload a PDF, DOCX, TXT, PNG, or JPEG file for text extraction',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(DocumentFileInterceptor)
  upload(@UploadedFile() file?: BufferedUpload) {
    return this.documents.upload(file);
  }

  @Get()
  list(@Query() query: ListDocumentsQueryDto) {
    return this.documents.list(query.page, query.limit);
  }

  @Get(':id/text')
  getText(@Param('id', ParseUUIDPipe) id: string) {
    return this.documents.getText(id);
  }

  @Get(':id/pages')
  pages(@Param('id', ParseUUIDPipe) id: string) {
    return this.documents.getPages(id);
  }

  @Post(':id/ocr')
  processOcr(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ProcessOcrDto = {},
  ) {
    return this.documents.processOcr(id, body);
  }

  @Get(':id')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.documents.getById(id);
  }

  @Post(':id/reprocess')
  reprocess(@Param('id', ParseUUIDPipe) id: string) {
    return this.documents.reprocess(id);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.documents.remove(id);
  }
}
