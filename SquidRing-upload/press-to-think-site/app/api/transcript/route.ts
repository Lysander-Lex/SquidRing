import { completion, json, parseCorrectedText, transcriptPrompt } from '../_shared';

export async function POST(request: Request) {
  const apiKey = request.headers.get('x-api-key')?.trim() || '';
  if (!apiKey) return json({ error: '没有模型密钥，已保留原始识别结果。' }, 401);
  try {
    const body = await request.json() as { baseUrl?: string, model?: string, transcript?: string, context?: string };
    const transcript = String(body.transcript || '').trim();
    if (!transcript) return json({ correctedText: '' });
    const raw = await completion(apiKey, body.baseUrl || 'https://api.deepseek.com', {
      model: body.model || 'deepseek-v4-pro',
      thinking: { type: 'disabled' },
      temperature: 0,
      max_tokens: 500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: transcriptPrompt },
        { role: 'user', content: `最近对话：\n${String(body.context || '').slice(-4000)}\n\n语音识别原文：\n${transcript}` },
      ],
    });
    return json({ correctedText: parseCorrectedText(raw, transcript), originalText: transcript });
  } catch (error) {
    const value = error as Error & { status?: number };
    return json({ error: value.message || '语音纠错失败' }, value.status || 502);
  }
}
