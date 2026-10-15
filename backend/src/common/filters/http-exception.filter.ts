import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const statusCode = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = this.safeMessage(exception, statusCode);

    if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        JSON.stringify({
          event: 'http_error',
          statusCode,
          method: request.method,
          path: request.path,
          errorType: exception instanceof Error ? exception.name : 'UnknownError',
        }),
      );
    }

    response.status(statusCode).json({
      statusCode,
      message,
      error: this.errorName(statusCode),
      path: request.path,
      timestamp: new Date().toISOString(),
    });
  }

  private safeMessage(exception: unknown, statusCode: number): string {
    if (!(exception instanceof HttpException)) {
      return 'Internal server error';
    }
    if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      return statusCode === HttpStatus.SERVICE_UNAVAILABLE
        ? 'Service temporarily unavailable'
        : 'Internal server error';
    }

    const body = exception.getResponse();
    if (typeof body === 'string') {
      return body;
    }
    if (typeof body === 'object' && body !== null && 'message' in body) {
      const value = body.message;
      if (typeof value === 'string') {
        return value;
      }
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        return value.join('; ');
      }
    }
    return 'Request failed';
  }

  private errorName(statusCode: number): string {
    if (statusCode === HttpStatus.SERVICE_UNAVAILABLE) return 'Service Unavailable';
    if (statusCode === HttpStatus.INTERNAL_SERVER_ERROR) return 'Internal Server Error';
    if (statusCode === HttpStatus.BAD_REQUEST) return 'Bad Request';
    return 'Request Error';
  }
}
