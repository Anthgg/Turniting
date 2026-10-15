import { HttpException, HttpStatus } from '@nestjs/common';

export type SupportedFileType = 'pdf' | 'docx' | 'txt';

export type BufferedUpload = {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
};

export type ValidatedUpload = {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  size: number;
  fileType: SupportedFileType;
};

const MIME_TYPES: Record<SupportedFileType, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
};

export function uploadException(
  status: number,
  code: string,
  message: string,
): HttpException {
  return new HttpException({ code, message }, status);
}

export function validateDocumentFile(
  file: BufferedUpload | undefined,
  maxBytes: number,
): ValidatedUpload {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw uploadException(
      HttpStatus.BAD_REQUEST,
      'FILE_REQUIRED',
      'A file is required',
    );
  }
  if (file.size > maxBytes || file.buffer.byteLength > maxBytes) {
    throw uploadException(
      HttpStatus.PAYLOAD_TOO_LARGE,
      'FILE_TOO_LARGE',
      'File exceeds the maximum upload size',
    );
  }
  if (file.size === 0 || file.buffer.byteLength === 0) {
    throw uploadException(
      HttpStatus.BAD_REQUEST,
      'FILE_EMPTY',
      'File must not be empty',
    );
  }

  const submittedBaseName =
    file.originalname.replace(/\\/g, '/').split('/').pop() ?? '';
  const extension = extensionFromName(submittedBaseName);
  if (!extension) {
    throw uploadException(
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      'UNSUPPORTED_FILE_TYPE',
      'Only PDF, DOCX, and TXT files are supported',
    );
  }

  const fileType = extension.slice(1) as SupportedFileType;
  const expectedMime = MIME_TYPES[fileType];
  const submittedMime = file.mimetype.split(';', 1)[0]?.trim().toLowerCase();
  if (submittedMime !== expectedMime) {
    throw uploadException(
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      'FILE_MIME_MISMATCH',
      'File extension and MIME type do not match',
    );
  }

  if (!matchesSignature(file.buffer, fileType)) {
    throw uploadException(
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      'INVALID_FILE_SIGNATURE',
      'File content does not match its declared type',
    );
  }

  return {
    buffer: file.buffer,
    originalName: sanitizeOriginalName(submittedBaseName, extension),
    mimeType: expectedMime,
    size: file.buffer.byteLength,
    fileType,
  };
}

function extensionFromName(name: string): string | undefined {
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
  return ['.pdf', '.docx', '.txt'].includes(extension) ? extension : undefined;
}

function sanitizeOriginalName(name: string, extension: string): string {
  const stem = removeControlCharacters(
    name.slice(0, name.length - extension.length).normalize('NFC'),
  )
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 180);
  return `${stem || 'document'}${extension}`;
}

function matchesSignature(
  buffer: Buffer,
  fileType: SupportedFileType,
): boolean {
  if (fileType === 'pdf') {
    const headerOffset = buffer
      .subarray(0, Math.min(buffer.length, 1024))
      .indexOf(Buffer.from('%PDF-'));
    return headerOffset >= 0;
  }
  if (fileType === 'docx') return isDocxContainer(buffer);
  return isText(buffer);
}

function isText(buffer: Buffer): boolean {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      text = new TextDecoder('windows-1252', { fatal: true }).decode(buffer);
    } catch {
      return false;
    }
  }
  for (const character of text) {
    const code = character.codePointAt(0);
    if (
      code !== undefined &&
      ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127)
    ) {
      return false;
    }
  }
  return true;
}

function removeControlCharacters(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0);
      return code === undefined || (code >= 32 && code !== 127);
    })
    .join('');
}

function isDocxContainer(buffer: Buffer): boolean {
  const minimumEndRecordLength = 22;
  const maximumCommentLength = 65_535;
  if (
    buffer.length < minimumEndRecordLength ||
    buffer.readUInt32LE(0) !== 0x04034b50
  )
    return false;

  const earliestEndRecord = Math.max(
    0,
    buffer.length - minimumEndRecordLength - maximumCommentLength,
  );
  let endRecordOffset = -1;
  for (
    let offset = buffer.length - minimumEndRecordLength;
    offset >= earliestEndRecord;
    offset -= 1
  ) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      endRecordOffset = offset;
      break;
    }
  }
  if (
    endRecordOffset < 0 ||
    endRecordOffset + minimumEndRecordLength > buffer.length
  )
    return false;

  const diskNumber = buffer.readUInt16LE(endRecordOffset + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(endRecordOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(endRecordOffset + 8);
  const entryCount = buffer.readUInt16LE(endRecordOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(endRecordOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(endRecordOffset + 16);
  const commentLength = buffer.readUInt16LE(endRecordOffset + 20);

  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount < 2 ||
    entryCount > 5_000 ||
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff ||
    endRecordOffset + minimumEndRecordLength + commentLength !==
      buffer.length ||
    centralDirectoryOffset + centralDirectorySize > endRecordOffset
  ) {
    return false;
  }

  let cursor = centralDirectoryOffset;
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  const names = new Set<string>();
  let totalUncompressedBytes = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > centralDirectoryEnd ||
      buffer.readUInt32LE(cursor) !== 0x02014b50
    )
      return false;
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const entryFlags = buffer.readUInt16LE(cursor + 8);
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const entryCommentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const entryEnd = nameStart + nameLength + extraLength + entryCommentLength;
    if (
      entryEnd > centralDirectoryEnd ||
      (entryFlags & 0x41) !== 0 ||
      ![0, 8].includes(compressionMethod) ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset + 30 > centralDirectoryOffset
    ) {
      return false;
    }

    let entryName: string;
    try {
      entryName = new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(nameStart, nameStart + nameLength),
      );
    } catch {
      return false;
    }
    if (
      entryName.includes('\\') ||
      entryName.startsWith('/') ||
      entryName.split('/').includes('..')
    )
      return false;
    names.add(entryName);

    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) return false;
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const localFlags = buffer.readUInt16LE(localHeaderOffset + 6);
    const localCompressionMethod = buffer.readUInt16LE(localHeaderOffset + 8);
    const localNameStart = localHeaderOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    const fileDataStart = localNameEnd + localExtraLength;
    if (
      fileDataStart + compressedSize > centralDirectoryOffset ||
      localNameLength !== nameLength ||
      localFlags !== entryFlags ||
      localCompressionMethod !== compressionMethod
    ) {
      return false;
    }
    if (
      !buffer
        .subarray(localNameStart, localNameEnd)
        .equals(buffer.subarray(nameStart, nameStart + nameLength))
    )
      return false;

    totalUncompressedBytes += uncompressedSize;
    if (
      uncompressedSize > 50 * 1024 * 1024 ||
      totalUncompressedBytes > 100 * 1024 * 1024
    )
      return false;
    cursor = entryEnd;
  }

  return (
    cursor === centralDirectoryEnd &&
    names.has('[Content_Types].xml') &&
    names.has('word/document.xml')
  );
}
