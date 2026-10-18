import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportCleanup } from './report-cleanup.js';
import type { ReportCleanupMetrics, ReportService } from './report.service.js';

const metrics: ReportCleanupMetrics = {
  expiredCount: 2,
  deletedFiles: 1,
  missingFiles: 1,
  failedDeletes: 0,
};

describe('ReportCleanup', () => {
  let cleanupExpired: ReturnType<typeof vi.fn>;
  let cleanup: ReportCleanup;

  beforeEach(() => {
    cleanupExpired = vi.fn().mockResolvedValue(metrics);
    cleanup = new ReportCleanup({ cleanupExpired } as unknown as ReportService);
  });

  it('returns and logs aggregate retention metrics without document content', async () => {
    const log = vi.spyOn((cleanup as any).logger, 'log');
    const result = await cleanup.run(new Date('2026-10-18T12:00:00.000Z'));

    expect(result).toEqual(metrics);
    expect(cleanupExpired).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: 'report_cleanup_completed', ...metrics }),
    );
    cleanup.onModuleDestroy();
  });

  it('does not overlap a concurrent cleanup run', async () => {
    let finish!: (value: ReportCleanupMetrics) => void;
    cleanupExpired.mockImplementationOnce(
      () => new Promise<ReportCleanupMetrics>((resolve) => (finish = resolve)),
    );
    const first = cleanup.run();
    const overlapping = await cleanup.run();

    expect(overlapping).toEqual({
      expiredCount: 0,
      deletedFiles: 0,
      missingFiles: 0,
      failedDeletes: 0,
    });
    expect(cleanupExpired).toHaveBeenCalledOnce();

    finish(metrics);
    await expect(first).resolves.toEqual(metrics);
    cleanup.onModuleDestroy();
  });
});
