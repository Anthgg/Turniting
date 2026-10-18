import { readdir, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cleanupReportSmokeTempFiles,
  createReportSmokeTempDirectory,
} from './report-temp-cleanup.js';

describe('report smoke temp cleanup', () => {
  it('removes each scoped fixture file and leaves zero artifacts', async () => {
    const directory = await createReportSmokeTempDirectory();
    try {
      await Promise.all(
        Array.from({ length: 7 }, (_, index) =>
          writeFile(join(directory, `synthetic-${index}.pdf`), 'synthetic'),
        ),
      );

      const result = await cleanupReportSmokeTempFiles(directory);

      expect(result).toEqual({ removed: 7, remaining: 0 });
      expect(await readdir(directory)).toHaveLength(0);
    } finally {
      const remaining = await readdir(directory);
      if (remaining.length > 0) await cleanupReportSmokeTempFiles(directory);
      await rmdir(directory);
    }
  });
});
