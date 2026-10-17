import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  CommercialEligibility,
  DatasetSplit,
  LabelSource,
  ModelStatus,
  ModelType,
  StorageProvider,
  TrainingLabel,
} from '@prisma/client';

const RELATIVE_PATH = /^(?![\\/])(?!.*\.\.)[\w./\\-]+$/;

export class DatasetPaginationQueryDto {
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

export class RegisterDatasetDto {
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{2,60}$/)
  name: string;

  @IsString()
  @Matches(/^V[0-9]{1,4}$/)
  version: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /** Directory (relative to TRAINING_DIR) holding datasets.json, licenses.json, master/split manifests. */
  @IsOptional()
  @IsString()
  @Matches(RELATIVE_PATH)
  manifestPath?: string;

  /** dataset_statistics.json, relative to TRAINING_DIR. */
  @IsOptional()
  @IsString()
  @Matches(RELATIVE_PATH)
  statisticsPath?: string;
}

export class ImportManifestDto {
  @IsOptional()
  @IsString()
  @Matches(RELATIVE_PATH)
  manifestPath?: string;

  @IsOptional()
  @IsString()
  @Matches(RELATIVE_PATH)
  statisticsPath?: string;
}

export class ListTrainingSamplesQueryDto extends DatasetPaginationQueryDto {
  @IsOptional()
  @IsEnum(TrainingLabel)
  label?: TrainingLabel;

  @IsOptional()
  @IsEnum(LabelSource)
  labelSource?: LabelSource;

  @IsOptional()
  @IsEnum(DatasetSplit)
  split?: DatasetSplit;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  language?: string;

  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  eligibleForTraining?: boolean;
}

export class ImportModelRegistryDto {
  @IsOptional()
  @IsString()
  @Matches(RELATIVE_PATH)
  registryPath?: string;

  @IsUUID()
  datasetVersionId: string;
}

export class RegisterModelVersionDto {
  @IsString()
  @Matches(/^[A-Z0-9_]{3,80}$/)
  name: string;

  @IsString()
  @MaxLength(200)
  architecture: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  variant?: string;

  @IsOptional()
  @IsUUID()
  datasetVersionId?: string;

  @IsEnum(ModelType)
  modelType: ModelType;

  @IsEnum(ModelStatus)
  status: ModelStatus;

  @IsEnum(CommercialEligibility)
  commercialEligibility: CommercialEligibility;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  trainingEnvironment?: string;

  @IsOptional()
  @IsEnum(StorageProvider)
  artifactProvider?: StorageProvider;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  artifactPath?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  gitCommit?: string;

  @IsObject()
  metrics: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  thresholds?: Record<string, number | null>;

  @IsOptional()
  @IsObject()
  calibration?: Record<string, unknown>;

  @IsOptional()
  @IsString({ each: true })
  limitations?: string[];

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
