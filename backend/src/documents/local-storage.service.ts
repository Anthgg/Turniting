import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { SupportedFileType } from './file-validation.js';
import { StorageService } from './storage.service.js';

const STORAGE_KEY_PATTERN =
  /^(?:turnitin\/)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(pdf|docx|txt)$/i;

@Injectable()
export class LocalStorageService extends StorageService {
  private readonly rootDirectory: string;

  constructor(config: ConfigService) {
    super();
    this.rootDirectory = path.resolve(config.getOrThrow<string>('UPLOAD_DIR'));
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
  }

  override async save(
    buffer: Buffer,
    fileType: SupportedFileType,
  ): Promise<string> {
    const storageKey = `${randomUUID()}.${fileType}`;
    const filePath = this.resolvePath(storageKey);
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    let handle: FileHandle | undefined;
    let created = false;
    try {
      handle = await open(filePath, 'wx', 0o600);
      created = true;
      await handle.writeFile(buffer);
    } catch (error) {
      try {
        await handle?.close();
      } catch {
        // Preserve the original storage error.
      }
      if (created) {
        try {
          await unlink(filePath);
        } catch {
          // The service has no logger or caller-visible path by design.
        }
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
    return storageKey;
  }

  override async saveTurnitinReport(buffer: Buffer): Promise<string> {
    const storageKey = `turnitin/${randomUUID()}.pdf`;
    const directory = path.join(this.rootDirectory, 'turnitin');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const [root, actualDirectory] = await Promise.all([
      realpath(this.rootDirectory),
      realpath(directory),
    ]);
    if (!isWithinDirectory(root, actualDirectory)) {
      throw new Error('Turnitin directory escapes upload directory');
    }
    const filePath = this.resolvePath(storageKey);
    let handle: FileHandle | undefined;
    let created = false;
    try {
      handle = await open(filePath, 'wx', 0o600);
      created = true;
      await handle.writeFile(buffer);
    } catch (error) {
      try {
        await handle?.close();
      } catch {
        // Preserve the original storage error.
      }
      if (created) {
        try {
          await unlink(filePath);
        } catch {
          // The service has no logger or caller-visible path by design.
        }
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
    return storageKey;
  }

  override async read(storageKey: string): Promise<Buffer> {
    const filePath = await this.resolveExistingPath(storageKey);
    return readFile(filePath);
  }

  override async exists(storageKey: string): Promise<boolean> {
    const filePath = this.resolvePath(storageKey);
    try {
      const stats = await lstat(filePath);
      return stats.isFile() && !stats.isSymbolicLink();
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  override async delete(storageKey: string): Promise<boolean> {
    const filePath = this.resolvePath(storageKey);
    try {
      await unlink(filePath);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  private async resolveExistingPath(storageKey: string): Promise<string> {
    const filePath = this.resolvePath(storageKey);
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error('Stored object is not a regular file');
    }
    const [root, file] = await Promise.all([
      realpath(this.rootDirectory),
      realpath(filePath),
    ]);
    if (!isWithinDirectory(root, file)) {
      throw new Error('Storage key escapes upload directory');
    }
    return file;
  }

  private resolvePath(storageKey: string): string {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) {
      throw new Error('Invalid storage key');
    }
    const root = path.resolve(this.rootDirectory);
    const file = path.resolve(root, storageKey);
    if (!isWithinDirectory(root, file)) {
      throw new Error('Storage key escapes upload directory');
    }
    return file;
  }
}

function isWithinDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
