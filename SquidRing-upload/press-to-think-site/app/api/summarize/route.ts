import { completion, json, parseSummary, summaryPrompt } from '../_shared';

export async function POST(request: Request) {
  const apiKey = request.headers.get('x-api-key')?.trim() || '';
  if (!apiKey) return json({ error: '请先设置 DeepSeek API Key。' }, 401);
  try {
    const body = await request.json() as { baseUrl?: string, model?: string, question?: string, fullAnswer?: string };
    const full = String(body.fullAnswer || '').trim();
    if (!full) return json({ error: '没有可总结的完整回答。' }, 400);
    const raw = await completion(apiKey, body.baseUrl || 'https://api.deepseek.com', {
      model: body.model || 'deepseek-v4-pro', thinking: { type: 'disabled' }, temperature: 0.2, max_tokens: 900,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: summaryPrompt }, { role: 'user', content: `用户的问题：${body.question || ''}\n\n完整回答：\n${full}` }],
    });
    return json({ spokenAnswer: parseSummary(full, raw), model: body.model || 'deepseek-v4-pro' });
  } catch (error) {
    const value = error as Error & { status?: number };
    return json({ error: value.message || '摘要生成失败' }, value.status || 502);
  }
}
