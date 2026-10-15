import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Observable } from 'rxjs';
import { uploadException } from '../documents/file-validation.js';

@Injectable()
export class TurnitinReportFileInterceptor implements NestInterceptor {
  private readonly fileInterceptor: NestInterceptor;

  constructor(config: ConfigService) {
    const configuredInterceptor = FileInterceptor('file', {
      limits: {
        fileSize:
          config.getOrThrow<number>('MAX_TURNITIN_REPORT_MB') * 1024 * 1024,
        files: 1,
        fields: 0,
        parts: 1,
      },
    });
    this.fileInterceptor = new configuredInterceptor({});
  }

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    try {
      return (await this.fileInterceptor.intercept(
        context,
        next,
      )) as Observable<unknown>;
    } catch (error) {
      if (
        error instanceof PayloadTooLargeException ||
        (error instanceof HttpException && error.getStatus() === 413)
      ) {
        throw uploadException(
          413,
          'FILE_TOO_LARGE',
          'Turnitin report exceeds the maximum upload size',
        );
      }
      throw error;
    }
  }
}
