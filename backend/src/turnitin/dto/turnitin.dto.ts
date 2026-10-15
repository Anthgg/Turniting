import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export enum TurnitinReportTypeDto {
  AI_WRITING = 'AI_WRITING',
  SIMILARITY = 'SIMILARITY',
  UNKNOWN = 'UNKNOWN',
}

export enum TurnitinReportStatusDto {
  UPLOADED = 'UPLOADED',
  PROCESSING = 'PROCESSING',
  PARSED = 'PARSED',
  PARTIAL = 'PARTIAL',
  FAILED = 'FAILED',
  OCR_REQUIRED = 'OCR_REQUIRED',
}

export enum TurnitinSegmentTypeDto {
  AI_FLAGGED = 'AI_FLAGGED',
  SIMILARITY_MATCH = 'SIMILARITY_MATCH',
  NOT_FLAGGED = 'NOT_FLAGGED',
  UNKNOWN = 'UNKNOWN',
}

export enum GroundTruthCaseTypeDto {
  AI_REPORT = 'AI_REPORT',
  SIMILARITY_REPORT = 'SIMILARITY_REPORT',
  VALIDATION = 'VALIDATION',
}

export enum TurnitinMatchStatusDto {
  UNVERIFIED = 'UNVERIFIED',
  EXACT = 'EXACT',
  HIGH = 'HIGH',
  PARTIAL = 'PARTIAL',
  MISMATCH = 'MISMATCH',
}

export class PaginationQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

export class ListTurnitinReportsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(TurnitinReportTypeDto)
  reportType?: TurnitinReportTypeDto;

  @IsOptional()
  @IsEnum(TurnitinReportStatusDto)
  status?: TurnitinReportStatusDto;
}

export class ListTurnitinSegmentsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(TurnitinSegmentTypeDto)
  segmentType?: TurnitinSegmentTypeDto;
}

export class MatchDocumentVersionDto {
  @IsUUID()
  documentVersionId!: string;
}

export class CreateGroundTruthCaseDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsEnum(GroundTruthCaseTypeDto)
  caseType!: GroundTruthCaseTypeDto;

  @IsOptional()
  @IsUUID()
  aiReportId?: string;

  @IsOptional()
  @IsUUID()
  similarityReportId?: string;

  @IsOptional()
  @IsUUID()
  documentVersionId?: string;

  @IsOptional()
  @IsObject()
  expectedData?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

export class UpdateGroundTruthCaseDto {
  @IsOptional()
  @IsObject()
  expectedData?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;
}
