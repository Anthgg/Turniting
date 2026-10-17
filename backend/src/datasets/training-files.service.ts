import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

/**
 * Read-only access to the versioned training/ directory (manifests, reports, configs).
 * Every path is resolved relative to TRAINING_DIR and must stay inside it.
 */
@Injectable()
export class TrainingFilesService {
  private readonly root: string;

  constructor(config: ConfigService) {
    this.root = path.resolve(config.getOrThrow<string>('TRAINING_DIR'));
  }

  resolve(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
      throw new BadRequestException('Training paths must be relative to TRAINING_DIR');
    }
    const resolved = path.resolve(this.root, relativePath);
    const rel = path.relative(this.root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new BadRequestException('Training path escapes TRAINING_DIR');
    }
    return resolved;
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await stat(this.resolve(relativePath));
      return true;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      return false;
    }
  }

  async readJson(relativePath: string): Promise<unknown> {
    const file = this.resolve(relativePath);
    let info;
    try {
      info = await stat(file);
    } catch {
      throw new NotFoundException(`Training manifest not found: ${relativePath}`);
    }
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) {
      throw new BadRequestException(`Training manifest ${relativePath} is not a file or exceeds ${MAX_MANIFEST_BYTES} bytes`);
    }
    try {
      return JSON.parse(await readFile(file, 'utf-8')) as unknown;
    } catch {
      throw new BadRequestException(`Training manifest ${relativePath} is not valid JSON`);
    }
  }

  /** SHA-256 and size of a local file, or null when it is not present locally. */
  async fingerprint(relativePath: string): Promise<{ sha256: string; sizeBytes: number } | null> {
    const file = this.resolve(relativePath);
    let info;
    try {
      info = await stat(file);
    } catch {
      return null;
    }
    if (!info.isFile()) return null;
    const digest = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      createReadStream(file)
        .on('data', (chunk) => digest.update(chunk))
        .on('end', () => resolve())
        .on('error', reject);
    });
    return { sha256: digest.digest('hex'), sizeBytes: info.size };
  }
}
