const basePrompt = `你是 Press to Think 中的通用 AI 搭档。正常理解并回答用户，不限定为任何固定角色。回答完整、准确、结构清晰，先给结论，不复述问题。遇到“最近、今天、目前、最新、价格、政策、活动、新闻、公司动态”等时效性问题，必须使用网页搜索后回答；引用关键事实时在正文中给出来源名称和可访问链接，不得编造来源。`;
export const summaryPrompt = `你是语音内容编辑。把完整回答真正压缩成适合耳机播放的中文口语总结。保留结论、最关键的二到四个理由和下一步；删除例子、铺垫和重复内容。不得照抄全文，不说“下面是总结”。控制在正文的25%到45%，最长650个汉字。只返回严格JSON：{"spokenAnswer":"..."}。`;
export const transcriptPrompt = `你是中文语音识别纠错器。根据对话上下文修正同音字、近音字、断句和明显的专有名词识别错误，尤其关注公司名、产品名、人名和技术名词。严格保留用户原意、语气和问题结构；不回答问题，不补充用户没说过的事实。只返回严格JSON：{"correctedText":"..."}。`;

export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function endpoint(baseUrl: string) {
  const parsed = new URL(baseUrl || 'https://api.deepseek.com');
  if (parsed.protocol !== 'https:') throw new Error('接口地址必须使用 HTTPS');
  return `${parsed.href.replace(/\/+$/, '')}/chat/completions`;
}

function responsesEndpoint(baseUrl: string) {
  const parsed = new URL(baseUrl || 'https://api.deepseek.com');
  if (parsed.protocol !== 'https:') throw new Error('接口地址必须使用 HTTPS');
  return `${parsed.href.replace(/\/+$/, '')}/responses`;
}

export async function completion(apiKey: string, baseUrl: string, body: Record<string, unknown>) {
  const response = await fetch(endpoint(baseUrl), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => null) as { error?: { message?: string }, choices?: Array<{ message?: { content?: string } }> } | null;
  if (!response.ok) throw Object.assign(new Error(payload?.error?.message || `模型服务返回 ${response.status}`), { status: response.status });
  const content = payload?.choices?.[0]?.message?.content?.trim();
  if (!content) throw Object.assign(new Error('模型没有返回有效内容'), { status: 502 });
  return content;
}

export async function responseWithSearch(apiKey: string, baseUrl: string, body: Record<string, unknown>) {
  const response = await fetch(responsesEndpoint(baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as {
    error?: { message?: string },
    output?: Array<{ type?: string, content?: Array<{ type?: string, text?: string }> }>,
  } | null;
  if (!response.ok) throw Object.assign(new Error(payload?.error?.message || `模型服务返回 ${response.status}`), { status: response.status });
  const content = payload?.output
    ?.filter(item => item.type === 'message')
    .flatMap(item => item.content || [])
    .filter(item => item.type === 'output_text')
    .map(item => item.text || '')
    .join('\n')
    .trim();
  if (!content) throw Object.assign(new Error('模型没有返回有效内容'), { status: 502 });
  const searched = Boolean(payload?.output?.some(item => item.type === 'web_search_call'));
  return { content, searched };
}

export function promptFor(mode: 'normal' | 'deep') {
  const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long', timeZone: 'Asia/Shanghai' }).format(new Date());
  return `${basePrompt}\n今天是${date}。${mode === 'deep' ? '当前为深度模式：充分比较方案并指出风险。' : '当前为快速模式：优先直接和实用。'}`;
}

function fallbackSummary(full: string) {
  const sentences = full.match(/[^。！？!?\n]+[。！？!?]?/g)?.map(item => item.trim()).filter(Boolean) || [];
  const limit = Math.max(48, Math.min(520, Math.floor(full.length * .52)));
  const preferred = sentences.filter((sentence, index) => index === 0 || /(结论|核心|因此|所以|建议|应该|需要|关键|风险|注意|下一步)/.test(sentence));
  return (preferred.length ? preferred : sentences).join('').slice(0, limit);
}

export function parseSummary(full: string, raw: string) {
  let candidate = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { candidate = String(JSON.parse(candidate).spokenAnswer || '').trim(); } catch {}
  const clean = (text: string) => text.replace(/\s|[，。！？、；：,.!?;:'"“”‘’（）()《》]/g, '').length;
  if (!candidate || candidate === full || (clean(full) > 220 && clean(candidate) > clean(full) * .62)) return fallbackSummary(full);
  return candidate.slice(0, 700);
}

export function parseCorrectedText(raw: string, fallback: string) {
  const candidate = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const value = String(JSON.parse(candidate).correctedText || '').trim();
    return value && value.length <= Math.max(2000, fallback.length * 2) ? value : fallback;
  } catch { return fallback; }
}
