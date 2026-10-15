import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AiTestAnalysisResponse, AiService } from './ai.service.js';
import { AnalyzeTestDto } from './dto/analyze-test.dto.js';

@ApiTags('ai')
@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('analyze/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Forward a test payload to the FastAPI contract endpoint' })
  @ApiBody({ type: AnalyzeTestDto })
  @ApiResponse({ status: 200, description: 'Test payload analyzed by the AI service' })
  @ApiResponse({ status: 503, description: 'AI service is unavailable' })
  analyzeTest(@Body() request: AnalyzeTestDto): Promise<AiTestAnalysisResponse> {
    return this.aiService.analyzeTest(request.text);
  }
}
