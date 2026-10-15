import { describe, expect, it } from 'vitest';
import { makeDocx } from '../../test/document-fixtures.js';
import { validateDocumentFile } from './file-validation.js';

describe('validateDocumentFile', () => {
  it.each([
    {
      name: 'PDF',
      originalname: 'assignment.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7\nexample'),
      fileType: 'pdf',
    },
    {
      name: 'DOCX',
      originalname: 'assignment.docx',
      mimetype:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: makeDocx(),
      fileType: 'docx',
    },
    {
      name: 'TXT',
      originalname: 'assignment.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from('Texto con acentos y emoji 📝', 'utf8'),
      fileType: 'txt',
    },
  ])(
    'accepts a valid $name file with matching MIME, extension, and signature',
    (file) => {
      expect(
        validateDocumentFile(
          {
            buffer: file.buffer,
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.buffer.length,
          },
          1024 * 1024,
        ),
      ).toMatchObject({
        fileType: file.fileType,
        mimeType: file.mimetype,
        size: file.buffer.length,
      });
    },
  );

  it('sanitizes a user supplied path and controls before storing its name', () => {
    const validated = validateDocumentFile(
      {
        buffer: Buffer.from('safe text'),
        originalname: '..\\private\\report\n?.txt',
        mimetype: 'text/plain',
        size: 9,
      },
      1024,
    );
    expect(validated.originalName).toBe('report_.txt');
  });

  it('accepts Windows-1252 TXT so legacy Latin-1 text can be sent to extraction', () => {
    const buffer = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    expect(
      validateDocumentFile(
        {
          buffer,
          originalname: 'legacy.txt',
          mimetype: 'text/plain',
          size: buffer.length,
        },
        1024,
      ).fileType,
    ).toBe('txt');
  });

  it('returns a stable 413 code for oversize files', () => {
    try {
      validateDocumentFile(
        {
          buffer: Buffer.from('%PDF-1.7'),
          originalname: 'large.pdf',
          mimetype: 'application/pdf',
          size: 8,
        },
        7,
      );
      expect.fail('expected an oversize rejection');
    } catch (error) {
      expect(error).toMatchObject({
        status: 413,
        response: { code: 'FILE_TOO_LARGE' },
      });
    }
  });

  it.each([
    {
      file: {
        buffer: Buffer.from('plain'),
        originalname: 'file.pdf',
        mimetype: 'text/plain',
        size: 5,
      },
      code: 'FILE_MIME_MISMATCH',
    },
    {
      file: {
        buffer: Buffer.from('plain'),
        originalname: 'file.exe',
        mimetype: 'application/octet-stream',
        size: 5,
      },
      code: 'UNSUPPORTED_FILE_TYPE',
    },
    {
      file: {
        buffer: Buffer.from('not a pdf'),
        originalname: 'file.pdf',
        mimetype: 'application/pdf',
        size: 9,
      },
      code: 'INVALID_FILE_SIGNATURE',
    },
    {
      file: {
        buffer: Buffer.from([0x00, 0x01, 0xff]),
        originalname: 'file.txt',
        mimetype: 'text/plain',
        size: 3,
      },
      code: 'INVALID_FILE_SIGNATURE',
    },
    {
      file: {
        buffer: Buffer.from('PK\x03\x04bad'),
        originalname: 'file.docx',
        mimetype:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 7,
      },
      code: 'INVALID_FILE_SIGNATURE',
    },
  ])('rejects an invalid file with code $code', ({ file, code }) => {
    expect(() => validateDocumentFile(file, 1024)).toThrow(
      expect.objectContaining({ response: expect.objectContaining({ code }) }),
    );
  });

  it('requires a file and rejects empty uploads', () => {
    expect(() => validateDocumentFile(undefined, 1024)).toThrow(
      expect.objectContaining({
        response: { code: 'FILE_REQUIRED', message: 'A file is required' },
      }),
    );
    expect(() =>
      validateDocumentFile(
        {
          buffer: Buffer.alloc(0),
          originalname: 'empty.txt',
          mimetype: 'text/plain',
          size: 0,
        },
        1024,
      ),
    ).toThrow(
      expect.objectContaining({
        response: { code: 'FILE_EMPTY', message: 'File must not be empty' },
      }),
    );
  });
});
