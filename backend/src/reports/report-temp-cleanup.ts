import { lstat, mkdtemp, readdir, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPORT_SMOKE_TEMP_PREFIX = 'turniting-f009-pdf-smoke-';

export async function createReportSmokeTempDirectory(): Promise<string> {
  const root = await realpath(tmpdir());
  return mkdtemp(join(root, REPORT_SMOKE_TEMP_PREFIX));
}

/** Remove only regular files directly inside this task's scoped OS temp directory. */
export async function cleanupReportSmokeTempFiles(
  directory: string,
): Promise<{ removed: number; remaining: number }> {
  const expectedRoot = await realpath(tmpdir());
  const resolvedInput = resolve(directory);
  const actualDirectory = await realpath(resolvedInput);
  if (
    dirname(actualDirectory) !== expectedRoot ||
    !basename(actualDirectory).startsWith(REPORT_SMOKE_TEMP_PREFIX)
  ) {
    throw new Error('Refusing to clean an unscoped report smoke directory.');
  }

  const entries = await readdir(actualDirectory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('Report smoke temp directory may contain regular files only.');
  }

  for (const entry of entries) {
    const filePath = join(actualDirectory, entry.name);
    const file = await lstat(filePath);
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new Error('Refusing to remove a non-regular report smoke artifact.');
    }
    await unlink(filePath);
  }

  const remaining = (await readdir(actualDirectory)).length;
  return { removed: entries.length, remaining };
}
