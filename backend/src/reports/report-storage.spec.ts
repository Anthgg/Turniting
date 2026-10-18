import { ConfigService } from '@nestjs/config';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalReportStorage } from './report-storage.js';

describe('LocalReportStorage', () => {
  let root: string;
  let storage: LocalReportStorage;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'turniting-report-storage-'));
    storage = new LocalReportStorage({
      get: () => root,
    } as unknown as ConfigService);
    await storage.onModuleInit();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stores and removes a PDF through a generated UUID key', async () => {
    const key = 'e564fa70-4188-4e8e-a4eb-98fda94f8865.pdf';
    const content = Buffer.from('%PDF-1.7 synthetic report');

    await storage.save(key, content);

    expect(await storage.exists(key)).toBe(true);
    expect(await storage.read(key)).toEqual(content);
    await expect(storage.delete(key)).resolves.toBe(true);
    await expect(storage.delete(key)).resolves.toBe(false);
    expect(await storage.exists(key)).toBe(false);
  });

  it('rejects traversal paths before touching the filesystem', async () => {
    await expect(storage.read('../outside.pdf')).rejects.toThrow(
      'Invalid report storage key',
    );
    await expect(storage.delete('..\\outside.pdf')).rejects.toThrow(
      'Invalid report storage key',
    );
    await expect(
      storage.save(
        'subdir/e564fa70-4188-4e8e-a4eb-98fda94f8865.pdf',
        Buffer.from('x'),
      ),
    ).rejects.toThrow('Invalid report storage key');
  });
});
