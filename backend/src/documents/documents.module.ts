import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { OcrModule } from '../ocr/ocr.module.js';
import { DocumentFileInterceptor } from './document-file.interceptor.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentVersionsController } from './document-versions.controller.js';
import { DocumentsService } from './documents.service.js';
import { LocalStorageService } from './local-storage.service.js';
import { StorageService } from './storage.service.js';

@Module({
  imports: [AiModule, OcrModule, PrismaModule],
  controllers: [DocumentsController, DocumentVersionsController],
  providers: [
    DocumentsService,
    LocalStorageService,
    { provide: StorageService, useExisting: LocalStorageService },
    DocumentFileInterceptor,
  ],
  exports: [StorageService],
})
export class DocumentsModule {}
