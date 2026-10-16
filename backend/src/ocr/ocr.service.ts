import { Injectable } from '@nestjs/common';
import {
  AiDocumentFile,
  AiOcrProcessResponse,
  AiService,
} from '../ai/ai.service.js';

@Injectable()
export class OcrService {
  constructor(private readonly ai: AiService) {}

  processDocument(
    file: AiDocumentFile,
    options: { pages?: number[]; force?: boolean },
  ): Promise<AiOcrProcessResponse> {
    return this.ai.processDocumentOcr(file, options);
  }

  parseTurnitinOcrText(pages: string[]) {
    return this.ai.parseTurnitinOcrText(pages);
  }
}
