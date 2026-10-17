import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';

export const ANALYZER_MODES = ['V2_ONLY', 'V3_ONLY', 'ENSEMBLE'] as const;
export const THRESHOLD_PROFILES = ['BALANCED', 'LOW_FALSE_POSITIVE', 'VERY_LOW_FALSE_POSITIVE', 'CUSTOM'] as const;
export const GRANULARITIES = ['PARAGRAPH', 'DOCUMENT'] as const;
export const PARAGRAPH_MODES = ['STRICT_PARAGRAPH', 'CONTEXTUAL_PARAGRAPH'] as const;

export class AnalyzeDocumentDto {
  @IsIn(ANALYZER_MODES)
  analyzer: (typeof ANALYZER_MODES)[number] = 'V3_ONLY';

  @IsIn(THRESHOLD_PROFILES)
  thresholdProfile: (typeof THRESHOLD_PROFILES)[number] = 'BALANCED';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.000001)
  @Max(0.999999)
  customThreshold?: number;

  @IsIn(GRANULARITIES)
  granularity: (typeof GRANULARITIES)[number] = 'PARAGRAPH';

  @IsIn(PARAGRAPH_MODES)
  paragraphMode: (typeof PARAGRAPH_MODES)[number] = 'CONTEXTUAL_PARAGRAPH';
}

export class CompareAnalysesDto {
  @IsUUID()
  baseAnalysisId!: string;

  @IsUUID()
  targetAnalysisId!: string;
}
