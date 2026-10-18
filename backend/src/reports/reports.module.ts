import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ReportCleanup } from './report-cleanup.js';
import { ReportController } from './report.controller.js';
import { ReportRenderer } from './report-renderer.js';
import { ReportService } from './report.service.js';
import { LocalReportStorage, REPORT_STORAGE } from './report-storage.js';

@Module({
  imports: [PrismaModule],
  controllers: [ReportController],
  providers: [
    ReportService,
    ReportRenderer,
    LocalReportStorage,
    { provide: REPORT_STORAGE, useExisting: LocalReportStorage },
    ReportCleanup,
  ],
  exports: [ReportService, ReportRenderer],
})
export class ReportsModule {}
