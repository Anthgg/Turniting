import { describe, expect, it, vi } from 'vitest';
import { AiService } from './ai.service.js';
import { AiController } from './ai.controller.js';

describe('AiController', () => {
  it('forwards the validated text to the AI service without persisting it', async () => {
    const aiService = {
      analyzeTest: vi.fn().mockResolvedValue({ status: 'ok', characters: 11, words: 2 }),
    };
    const controller = new AiController(aiService as unknown as AiService);

    await expect(controller.analyzeTest({ text: 'hello world' })).resolves.toEqual({
      status: 'ok',
      characters: 11,
      words: 2,
    });
    expect(aiService.analyzeTest).toHaveBeenCalledWith('hello world');
    expect(aiService.analyzeTest).toHaveBeenCalledTimes(1);
  });
});
