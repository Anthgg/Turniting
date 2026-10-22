import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { AnalyzerClassification } from '../../ai/ai.service.js';
import { ANALYZER_MODES, LANGUAGE_CODES, PARAGRAPH_MODES, THRESHOLD_PROFILES } from './analysis.dto.js';

export const QUICK_ANALYSIS_MAX_CHARS = 20_000;

export class QuickAnalysisDto {
  @IsString()
  @MinLength(1)
  @MaxLength(QUICK_ANALYSIS_MAX_CHARS)
  text!: string;

  @IsOptional()
  @IsIn(ANALYZER_MODES)
  analyzer?: (typeof ANALYZER_MODES)[number];

  @IsOptional()
  @IsIn(THRESHOLD_PROFILES.filter((profile) => profile !== 'CUSTOM'))
  thresholdProfile?: Exclude<(typeof THRESHOLD_PROFILES)[number], 'CUSTOM'>;

  @IsOptional()
  @IsIn(PARAGRAPH_MODES)
  paragraphMode?: (typeof PARAGRAPH_MODES)[number];

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
  analyzer: (typeof ANALYZER_MODES)[number];
  thresholdProfile: Exclude<(typeof THRESHOLD_PROFILES)[number], 'CUSTOM'>;
  paragraphMode: (typeof PARAGRAPH_MODES)[number];
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
