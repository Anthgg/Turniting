import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { OcrService } from './ocr.service.js';

@Module({
  imports: [AiModule],
  providers: [OcrService],
  exports: [OcrService],
})
export class OcrModule {}
