import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ReportArtifactStatus, ReportType } from '@prisma/client';

export class GenerateAIReportDto {
  @IsUUID()
  analysisRunId!: string;
}

export class GenerateSimilarityReportDto {
  @IsUUID()
  similarityRunId!: string;
}

export class ListReportsDto {
  @IsOptional()
  @IsUUID()
  documentId?: string;

  @IsOptional()
  @IsEnum(ReportType)
  type?: ReportType;

  @IsOptional()
  @IsEnum(ReportArtifactStatus)
  status?: ReportArtifactStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}
