import { json, promptFor, responseWithSearch } from '../_shared';

export async function POST(request: Request) {
  const apiKey = request.headers.get('x-api-key')?.trim() || '';
  if (!apiKey) return json({ error: '请先在右上角设置 DeepSeek API Key。' }, 401);
  try {
    const body = await request.json() as { baseUrl?: string, model?: string, mode?: string, messages?: Array<{ role: string, content: string }> };
    const mode = body.mode === 'deep' ? 'deep' : 'normal';
    const model = body.model || 'deepseek-v4-pro';
    const requestBody: Record<string, unknown> = {
      model,
      instructions: promptFor(mode),
      input: (body.messages || []).slice(-30).filter(item => ['user', 'assistant'].includes(item.role)).map(item => ({ role: item.role, content: String(item.content).slice(0, 20_000) })),
      tools: [{ type: 'web_search' }],
      tool_choice: 'auto',
      reasoning: { effort: mode === 'deep' ? 'high' : 'none' },
      max_output_tokens: mode === 'deep' ? 9000 : 5000,
    };
    if (mode === 'normal') requestBody.temperature = 0.65;
    const result = await responseWithSearch(apiKey, body.baseUrl || 'https://api.deepseek.com', requestBody);
    return json({ fullAnswer: result.content, model, searched: result.searched });
  } catch (error) {
    const value = error as Error & { status?: number };
    return json({ error: value.message || '模型请求失败' }, value.status || 502);
  }
}
