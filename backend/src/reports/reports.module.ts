import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { ReportCleanup } from './report-cleanup.js';
import { ReportController } from './report.controller.js';
import { ReportRenderer } from './report-renderer.js';
import { ReportService } from './report.service.js';
import { OriginalDocumentRenderer } from './original-document-renderer.js';
import { LocalReportStorage, REPORT_STORAGE } from './report-storage.js';

@Module({
  imports: [PrismaModule, DocumentsModule],
  controllers: [ReportController],
  providers: [
    ReportService,
    ReportRenderer,
    OriginalDocumentRenderer,
    LocalReportStorage,
    { provide: REPORT_STORAGE, useExisting: LocalReportStorage },
    ReportCleanup,
  ],
  exports: [ReportService, ReportRenderer],
})
export class ReportsModule {}
