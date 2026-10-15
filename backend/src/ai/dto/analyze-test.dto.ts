import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class AnalyzeTestDto {
  @ApiProperty({ description: 'Text passed to the FastAPI contract endpoint' })
  @IsString()
  text!: string;
}
