import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { DocumentFileInterceptor } from './document-file.interceptor.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { LocalStorageService } from './local-storage.service.js';
import { StorageService } from './storage.service.js';

@Module({
  imports: [AiModule, PrismaModule],
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
    LocalStorageService,
    { provide: StorageService, useExisting: LocalStorageService },
    DocumentFileInterceptor,
  ],
})
export class DocumentsModule {}
