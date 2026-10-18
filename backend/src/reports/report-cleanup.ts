import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  ReportService,
  type ReportCleanupMetrics,
} from './report.service.js';

export const REPORT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class ReportCleanup implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReportCleanup.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly reports: ReportService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.run(), REPORT_CLEANUP_INTERVAL_MS);
    this.timer.unref();
    void this.run();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async run(now = new Date()): Promise<ReportCleanupMetrics> {
    if (this.running)
      return {
        expiredCount: 0,
        deletedFiles: 0,
        missingFiles: 0,
        failedDeletes: 0,
      };
    this.running = true;
    try {
      const metrics = await this.reports.cleanupExpired(now);
      this.logger.log(
        JSON.stringify({ event: 'report_cleanup_completed', ...metrics }),
      );
      return metrics;
    } catch {
      this.logger.warn(JSON.stringify({ event: 'report_cleanup_run_failed' }));
      return {
        expiredCount: 0,
        deletedFiles: 0,
        missingFiles: 0,
        failedDeletes: 0,
      };
    } finally {
      this.running = false;
    }
  }
}
