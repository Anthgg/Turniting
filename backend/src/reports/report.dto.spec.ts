import 'reflect-metadata';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { GenerateAIReportDto, GenerateBothAIReportsDto } from './report.dto.js';

describe('explicit report analysis binding', () => {
  it.each([GenerateAIReportDto, GenerateBothAIReportsDto])('rejects a missing or invalid run ID for %s', async Dto => {
    const dto = new Dto();
    expect((await validate(dto)).some(error => error.property === 'analysisRunId')).toBe(true);
    dto.analysisRunId = 'latest';
    expect((await validate(dto)).some(error => error.property === 'analysisRunId')).toBe(true);
    dto.analysisRunId = 'f0094100-0000-4000-8000-000000000003';
    expect(await validate(dto)).toHaveLength(0);
  });
});
