import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class ProcessOcrDto {
  @IsOptional()
  @IsBoolean()
  force?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(150)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(100_000, { each: true })
  pages?: number[];
}
