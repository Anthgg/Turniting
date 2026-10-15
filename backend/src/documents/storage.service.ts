import type { SupportedFileType } from './file-validation.js';

export abstract class StorageService {
  abstract save(buffer: Buffer, fileType: SupportedFileType): Promise<string>;
  abstract saveTurnitinReport(buffer: Buffer): Promise<string>;
  abstract read(storageKey: string): Promise<Buffer>;
  abstract exists(storageKey: string): Promise<boolean>;
  abstract delete(storageKey: string): Promise<boolean>;
}
