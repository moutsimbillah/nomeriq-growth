import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveResearchProviders: vi.fn(),
  chatJson: vi.fn(),
  search: vi.fn(),
  fetchTool: vi.fn(),
  fetchSpy: vi.fn(),
}));

vi.mock('@/lib/deepseek/provider-pool', () => ({
  resolveResearchProviders: mocks.resolveResearchProviders,
}));

import { translateToEnglish } from '@/lib/ai/translation';

const model = 'fixture-model';
const privateString = 'synthetic-private-string';
const input = 'مرحبا';

beforeEach(() => {
  vi.stubEnv('AI_PROVIDER', 'deepseek');
  vi.stubGlobal('fetch', mocks.fetchSpy);
  for (const m of Object.values(mocks)) m.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('translateToEnglish non-DeepSeek providers', () => {
  it('translates through the DeepSeek pool without touching fetch', async () => {
    mocks.resolveResearchProviders.mockReturnValue({
      provider: { chatJson: mocks.chatJson, search: mocks.search, fetch: mocks.fetchTool },
      error: null,
      names: [model],
    });
    mocks.chatJson.mockResolvedValue({
      data: { sourceLanguage: 'ar', translatedText: 'Hello' },
      usage: { model },
    });

    const result = await translateToEnglish(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('EXPECTED_TRANSLATION_SUCCESS');
    expect(result.provider).toBe('deepseek');
    expect(result.sourceLanguage).toBe('ar');
    expect(mocks.chatJson).toHaveBeenCalledTimes(1);
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.fetchTool).not.toHaveBeenCalled();
    expect(mocks.fetchSpy).not.toHaveBeenCalled();
  });

  it('hides the raw pool error behind a safe reason', async () => {
    mocks.resolveResearchProviders.mockReturnValue({
      provider: null,
      error: new Error(privateString),
      names: [],
    });

    const result = await translateToEnglish(input);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('EXPECTED_TRANSLATION_FAILURE');
    expect(String(result.reason)).not.toContain(privateString);
  });

  it('translates through Anthropic over fetch', async () => {
    vi.stubEnv('AI_PROVIDER', 'anthropic');
    vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-anthropic-key');
    const payload = {
      content: [
        { type: 'text', text: JSON.stringify({ sourceLanguage: 'es', translatedText: 'Hello' }) },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
      model,
    };
    mocks.fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await translateToEnglish(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('EXPECTED_TRANSLATION_SUCCESS');
    expect(result.provider).toBe('anthropic');
    expect(result.sourceLanguage).toBe('es');
    const call = mocks.fetchSpy.mock.calls[0]?.[0] as { url?: string } | string | undefined;
    const url = typeof call === 'string' ? call : String(call?.url ?? '');
    expect(url).toContain('api.anthropic.com');
  });

  it('fails without fetching when the Anthropic key is missing', async () => {
    vi.stubEnv('AI_PROVIDER', 'anthropic');
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    const result = await translateToEnglish(input);

    expect(result.ok).toBe(false);
    expect(mocks.fetchSpy).not.toHaveBeenCalled();
  });
});
