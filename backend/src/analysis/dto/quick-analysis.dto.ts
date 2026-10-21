import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { AnalyzerClassification } from '../../ai/ai.service.js';
import { LANGUAGE_CODES } from './analysis.dto.js';

export const QUICK_ANALYSIS_MAX_CHARS = 20_000;

export class QuickAnalysisDto {
  @IsString()
  @MinLength(1)
  @MaxLength(QUICK_ANALYSIS_MAX_CHARS)
  text!: string;

  @IsOptional()
  @IsIn(LANGUAGE_CODES)
  languageCode?: (typeof LANGUAGE_CODES)[number];
}

export type QuickAnalysisParagraphStatus = 'MACHINE_SIGNAL' | 'LOW_SIGNAL' | 'INSUFFICIENT_TEXT';

export type QuickAnalysisResponse = {
  evaluated: boolean;
  score: number | null;
  scientificFlag: AnalyzerClassification | null;
  reviewHighlighted: boolean;
  scoredParagraphs: number;
  insufficientParagraphs: number;
  scientificThreshold: number;
  reviewThreshold: number;
  model: {
    id: string;
    displayName: string;
    version: string;
  };
  languageCode: (typeof LANGUAGE_CODES)[number];
  latencyMs: number;
  paragraphs: Array<{
    index: number;
    status: QuickAnalysisParagraphStatus;
    score: number | null;
    scientificFlag: boolean | null;
    reviewHighlighted: boolean;
  }>;
};
