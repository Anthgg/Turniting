import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ReportService } from './report.service.js';

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

  async run(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.reports.cleanupExpired(now);
    } catch {
      this.logger.warn(JSON.stringify({ event: 'report_cleanup_run_failed' }));
      return 0;
    } finally {
      this.running = false;
    }
  }
}
