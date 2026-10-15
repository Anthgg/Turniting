import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalStorageService } from './local-storage.service.js';

describe('LocalStorageService', () => {
  let root: string;
  let storage: LocalStorageService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'turniting-storage-test-'));
    storage = new LocalStorageService({
      getOrThrow: () => root,
    } as unknown as ConfigService);
    await storage.onModuleInit();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('uses UUID physical filenames and supports save, exists, read, and delete', async () => {
    const contents = Buffer.from('stored content');
    const storageKey = await storage.save(contents, 'txt');
    expect(storageKey).toMatch(/^[0-9a-f-]{36}\.txt$/i);
    expect(await storage.exists(storageKey)).toBe(true);
    expect(await storage.read(storageKey)).toEqual(contents);
    expect(await storage.delete(storageKey)).toBe(true);
    expect(await storage.exists(storageKey)).toBe(false);
    expect(await storage.delete(storageKey)).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    '..\\outside.txt',
    '../outside.txt',
    'C:\\secret.txt',
    '/etc/passwd',
    'not-a-uuid.txt',
  ])(
    'rejects keys that could escape the upload directory: %s',
    async (storageKey) => {
      await expect(storage.read(storageKey)).rejects.toThrow();
      await expect(storage.exists(storageKey)).rejects.toThrow();
      await expect(storage.delete(storageKey)).rejects.toThrow();
    },
  );
});
