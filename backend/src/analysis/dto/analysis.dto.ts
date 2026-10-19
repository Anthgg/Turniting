import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';

export const ANALYZER_MODES = ['V2_ONLY', 'V3_ONLY', 'ENSEMBLE', 'F006_1_ONLY', 'F006_1_1_ONLY'] as const;
export const LANGUAGE_CODES = ['es', 'en', 'other'] as const;
export const THRESHOLD_PROFILES = ['BALANCED', 'LOW_FALSE_POSITIVE', 'VERY_LOW_FALSE_POSITIVE', 'CUSTOM'] as const;
export const GRANULARITIES = ['PARAGRAPH', 'DOCUMENT'] as const;
export const PARAGRAPH_MODES = ['STRICT_PARAGRAPH', 'CONTEXTUAL_PARAGRAPH'] as const;
export const ANALYSIS_SEGMENT_SORTS = ['PARAGRAPH', 'SCORE_DESC'] as const;
export const ANALYSIS_SEGMENT_FILTERS = ['ALL', 'LOW', 'MODERATE', 'HIGH', 'INSUFFICIENT'] as const;

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
  paragraphMode: (typeof PARAGRAPH_MODES)[number] = 'STRICT_PARAGRAPH';

  @IsIn(LANGUAGE_CODES)
  languageCode?: (typeof LANGUAGE_CODES)[number] = 'other';
}

export class CompareAnalysesDto {
  @IsUUID()
  baseAnalysisId!: string;

  @IsUUID()
  targetAnalysisId!: string;
}

export class AnalysisSegmentsQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  includeDocumentText?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @IsIn(ANALYSIS_SEGMENT_SORTS)
  sort?: (typeof ANALYSIS_SEGMENT_SORTS)[number];

  @IsOptional()
  @IsIn(ANALYSIS_SEGMENT_FILTERS)
  filter?: (typeof ANALYSIS_SEGMENT_FILTERS)[number];
}
