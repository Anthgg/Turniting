import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  open,
  lstat,
  mkdir,
  readFile,
  realpath,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const STORAGE_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/;

export interface ReportStorageAdapter {
  save(storageKey: string, buffer: Buffer): Promise<void>;
  read(storageKey: string): Promise<Buffer>;
  exists(storageKey: string): Promise<boolean>;
  delete(storageKey: string): Promise<boolean>;
}

export const REPORT_STORAGE = Symbol('REPORT_STORAGE');

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/** Local report files use backend-generated UUID keys and remain outside the repository. */
@Injectable()
export class LocalReportStorage implements ReportStorageAdapter, OnModuleInit {
  private readonly rootDirectory: string;

  constructor(config: ConfigService) {
    const configured = config.get<string>('REPORT_STORAGE_ROOT')?.trim();
    this.rootDirectory = path.resolve(
      configured || path.join(tmpdir(), 'turniting-reports'),
    );
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
  }

  async save(storageKey: string, buffer: Buffer): Promise<void> {
    const target = this.resolvePath(storageKey);
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    await this.assertRootDirectory();
    let handle: FileHandle | undefined;
    let created = false;
    try {
      handle = await open(target, 'wx', 0o600);
      created = true;
      await handle.writeFile(buffer);
    } catch (error) {
      if (created) await unlink(target).catch(() => undefined);
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async read(storageKey: string): Promise<Buffer> {
    const target = this.resolvePath(storageKey);
    const stats = await lstat(target);
    if (!stats.isFile() || stats.isSymbolicLink())
      throw new Error('Stored report is not a regular file');
    const [root, actual] = await Promise.all([
      realpath(this.rootDirectory),
      realpath(target),
    ]);
    if (!within(root, actual))
      throw new Error('Report storage key escapes its root');
    return readFile(actual);
  }

  async exists(storageKey: string): Promise<boolean> {
    const target = this.resolvePath(storageKey);
    try {
      const stats = await lstat(target);
      return stats.isFile() && !stats.isSymbolicLink();
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async delete(storageKey: string): Promise<boolean> {
    const target = this.resolvePath(storageKey);
    try {
      await unlink(target);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  private resolvePath(storageKey: string): string {
    if (!STORAGE_KEY_PATTERN.test(storageKey))
      throw new Error('Invalid report storage key');
    const root = path.resolve(this.rootDirectory);
    const target = path.resolve(root, storageKey);
    if (!within(root, target))
      throw new Error('Report storage key escapes its root');
    return target;
  }

  private async assertRootDirectory(): Promise<void> {
    const root = await realpath(this.rootDirectory);
    if (path.resolve(root) !== path.resolve(this.rootDirectory)) {
      throw new Error(
        'Report storage root must not resolve through a symbolic link',
      );
    }
  }
}
