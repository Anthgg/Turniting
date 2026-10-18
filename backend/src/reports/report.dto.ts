import { IsUUID } from 'class-validator';

export class GenerateAIReportDto {
  @IsUUID()
  analysisRunId!: string;
}

export class GenerateSimilarityReportDto {
  @IsUUID()
  similarityRunId!: string;
}
