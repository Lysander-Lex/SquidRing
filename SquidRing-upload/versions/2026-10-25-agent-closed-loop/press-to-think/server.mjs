import http from 'node:http';
import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const dataRoot = fileURLToPath(new URL('./data/', import.meta.url));
const settingsPath = process.env.SETTINGS_PATH || join(dataRoot, 'settings.json');
const port = Number(process.env.PORT || 3210);
const host = process.env.HOST || '127.0.0.1';
const remoteMode = process.env.REMOTE_MODE === '1' || !['127.0.0.1', 'localhost', '::1'].includes(host);
const appAccessToken = String(process.env.APP_ACCESS_TOKEN || '');
if (remoteMode && appAccessToken.length < 32) throw new Error('远程部署必须设置至少32字符的 APP_ACCESS_TOKEN，并通过 HTTPS 反向代理访问');
function authorized(req) {
  if (!appAccessToken) return !remoteMode;
  const provided = Buffer.from(String(req.headers['x-app-token'] || ''));
  const expected = Buffer.from(appAccessToken);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}
const maxBodyBytes = 5_000_000;
const appVersion = '2.0.0';

let localSettings = {
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  model: 'deepseek-v4-pro',
  tencentAppId: '', tencentSecretId: '', tencentSecretKey: '', tencentAsr: false,
  tencentTts: false, tencentVoiceType: 101004,
};
try { localSettings = { ...localSettings, ...JSON.parse(await readFile(settingsPath, 'utf8')) }; } catch {}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

const basePrompt = `你是 Press to Think 中的通用 AI 搭档。正常理解并回答用户，不限定为创业、产品或任何固定角色。
回答要完整、准确、结构清晰，先给结论，不复述用户问题，不说“作为 AI”。如果缺少关键信息，明确说出并提出最少量的问题。
当前日期由系统消息提供。凡是涉及“最新、现在、今天、价格、政策、人物职位”等可能变化的信息，如果没有联网搜索结果，不得假装掌握实时事实；应明确说明知识边界。`;

const summaryPrompt = `你是 Press to Think 的思考整理器。阅读用户问题和完整回答，生成可展示、可播放的思考收束。
规则：
1. summary：整体概括回答的结论和关键理由，不只截取第一句话，通常 80–220 字。
2. suggestion：给用户一个最有价值、可以执行的下一步建议；没有合理建议时返回空字符串。
3. hypothesis：指出回答中最值得验证的一项假设或不确定性；纯事实型问题可返回空字符串。
4. followUp：写成用户点击后可直接发给 AI 的自然语言追问，例如“继续帮我设计这个验证实验”。不能写成 AI 对用户的提问。
5. spokenAnswer：适合耳机快速播放的自然口语摘要，只保留结论、关键理由和一个必要建议；不能照抄全文，控制在 80–220 个汉字。
6. 不说“下面是总结”“原文提到”“总的来说”。
7. 只返回严格 JSON：{"summary":"...","suggestion":"...","hypothesis":"...","followUp":"...","spokenAnswer":"..."}。`;

const transcriptPrompt = `你是 Press to Think 的中文语音输入纠错器。把浏览器产生的粗糙语音转写，修正成用户真正想说的自然中文。
你可以根据整句话和最近对话：
1. 修正同音字、近音字、错误断句和明显不通顺的语音识别结果，例如在 AI 语境中把“对话大冒险”纠正为“对话大模型”。
2. 正确书写技术词和产品名，例如 Press to Think、DeepSeek、XIAO、Agent、AI、API、BLE、Type-C、ChatGPT、Claude、Gemini、豆包、大语言模型、生成式 AI、具身智能、Vibe Coding。结合语境把“巨深智能”等近音误识别纠正为“具身智能”。
3. 添加合理标点，删除“呃、嗯”等无意义语气词，以及语音识别造成的紧邻重复片段。
4. 严格保留原意、语气、问题数量、数字和限定条件。不能回答问题，不能替用户扩写观点，不能补充用户没说过的事实。
5. “快速模式”和“深度模式”是产品的固定语音指令，必须原样保留。若粗转写出现“快问快答模式、快答模式、普通模式”等明显指向快速回答的表达，统一规范为“快速模式”；不得自行创造新的模式名称。
只返回严格 JSON：{"correctedText":"..."}。`;

const threadSearchPrompt = `你是会话检索器。根据用户的自然语言描述，从候选历史会话中找出语义最相关的一条。
需要理解近义表达和用户记得的大意，不能只匹配字面关键词。只能选择候选列表里真实存在的 id；如果没有合理匹配，selectedThreadId 返回空字符串。
只返回严格 JSON：{"selectedThreadId":"...","reason":"一句简短理由"}。`;

const commandRouterPrompt = `你是 Press to Think 的语音指令路由器。理解用户整句话中的操作意图，并把操作指令与真正要交给助手处理的内容分开。
支持的操作：
- 新建话题：例如“开个新话题”“另起一个会话”“这个我们重新聊”。
- 模式切换：快速模式或深度模式，可以出现在句首、句中或句尾。
- 恢复历史：例如“回到之前聊戒指和耳机的内容”“继续上周那个想法”。
规则：
1. 只有用户明确表达操作意图时才设置动作，不能因为普通问题提到“话题、快速、深入”等词就误触发。
2. 一句话可以同时包含多个动作和一个问题，必须全部识别。例如“开启新话题，切到深度模式，分析机器狗”应返回 newTopic=true、mode=deep、prompt=“分析机器狗”。
3. prompt 必须保留用户真正的任务、条件、语气和细节，只删除已经结构化的控制指令，不能概括或改写。
4. resumeQuery 只在用户要求找回历史内容时填写用户用于定位旧会话的描述；否则为空。
5. 若整句话只有控制指令，prompt 返回空字符串。
只返回严格 JSON：{"newTopic":false,"mode":"keep","resumeQuery":"","prompt":""}。mode 只能是 keep、fast、deep。`;

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBodyBytes) throw new Error('请求内容过大');
  }
  try { const parsed = JSON.parse(body || '{}');
    if (remoteMode && parsed && typeof parsed === 'object') { delete parsed.baseUrl; delete parsed.model; delete parsed.apiKey; }
    return parsed; }
  catch { throw new Error('请求格式不正确'); }
}

function publicSettings() {
  const key = String(localSettings.apiKey || '');
  return {
    hasApiKey: Boolean(key), keyHint: key ? `${key.slice(0, 3)}••••${key.slice(-4)}` : '',
    baseUrl: localSettings.baseUrl, model: localSettings.model,
    tencentAppId: localSettings.tencentAppId || '', tencentAsr: Boolean(localSettings.tencentAsr),
    hasTencentAsr: Boolean(localSettings.tencentAppId && localSettings.tencentSecretId && localSettings.tencentSecretKey),
    tencentTts: Boolean(localSettings.tencentTts),
    tencentVoiceType: Number(localSettings.tencentVoiceType || 101004),
    hasTencentTts: Boolean(localSettings.tencentAppId && localSettings.tencentSecretId && localSettings.tencentSecretKey),
    tencentKeyHint: localSettings.tencentSecretId ? `${localSettings.tencentSecretId.slice(0, 4)}••••${localSettings.tencentSecretId.slice(-4)}` : '',
  };
}

async function saveLocalSettings(req, res) {
  const body = await readJson(req);
  const apiKey = String(body.apiKey || '').trim();
  localSettings = {
    apiKey: apiKey || localSettings.apiKey,
    baseUrl: String(body.baseUrl || localSettings.baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, ''),
    model: String(body.model || localSettings.model || 'deepseek-v4-pro').trim(),
    tencentAppId: String(body.tencentAppId || localSettings.tencentAppId || '').trim(),
    tencentSecretId: String(body.tencentSecretId || localSettings.tencentSecretId || '').trim(),
    tencentSecretKey: String(body.tencentSecretKey || localSettings.tencentSecretKey || '').trim(),
    tencentAsr: body.tencentAsr == null ? Boolean(localSettings.tencentAsr) : Boolean(body.tencentAsr),
    tencentTts: body.tencentTts == null ? Boolean(localSettings.tencentTts) : Boolean(body.tencentTts),
    tencentVoiceType: Number(body.tencentVoiceType || localSettings.tencentVoiceType || 101004),
  };
  await mkdir(dataRoot, { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(localSettings, null, 2)}\n`, { mode: 0o600 });
  return sendJson(res, 200, publicSettings());
}

function tencentAsrUrl() {
  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    engine_model_type: '16k_zh_en_2.0', expired: timestamp + 3600, filter_dirty: 0,
    filter_modal: 0, filter_punc: 0, needvad: 1, nonce: Math.floor(Math.random() * 1_000_000_000),
    secretid: localSettings.tencentSecretId, timestamp, voice_format: 1, voice_id: crypto.randomUUID(),
  };
  const query = Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('&');
  const signingText = `asr.cloud.tencent.com/asr/v2/${localSettings.tencentAppId}?${query}`;
  const signature = crypto.createHmac('sha1', localSettings.tencentSecretKey).update(signingText).digest('base64');
  return `wss://${signingText}&signature=${encodeURIComponent(signature)}`;
}

async function recognizeTencentPcm(pcm) {
  try {
    return await recognizeTencentPcmAttempt(pcm);
  } catch (error) {
    if (error.providerCode !== 4008) throw error;
    // Retry the same saved recording once with a fresh voice_id/socket.
    return await recognizeTencentPcmAttempt(pcm);
  }
}

async function recognizeTencentPcmAttempt(pcm) {
  if (!localSettings.tencentAppId || !localSettings.tencentSecretId || !localSettings.tencentSecretKey) throw new Error('请先保存腾讯云 AppID、SecretId 和 SecretKey');
  if (!pcm.length) throw new Error('没有收到有效语音');
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(tencentAsrUrl());
    const sentences = new Map(); let started = false; let finished = false; let sentBytes = 0;
    let timeout;
    const fail = (message, providerCode) => {
      if (finished) return;
      finished = true; clearTimeout(timeout);
      try { socket.close(); } catch {}
      const error = new Error(message); error.providerCode = providerCode; reject(error);
    };
    timeout = setTimeout(() => fail('腾讯云识别超时，请重新提问'), Math.max(30_000, pcm.length / 32 + 15_000));
    socket.addEventListener('message', async event => {
      let data; try { data = JSON.parse(String(event.data)); } catch { return; }
      if (data.code !== 0) {
        const phase = !started ? '握手未完成' : `已发送 ${sentBytes}/${pcm.length} 字节音频`;
        return fail(`腾讯云：${data.message || data.code}（${phase}）`, Number(data.code));
      }
      if (!started) {
        started = true;
        // 16 kHz PCM16 mono: send each chunk at its actual duration (Tencent's 1:1 recommendation).
        try {
          for (let offset = 0; offset < pcm.length && !finished; offset += 6400) {
            const chunk = pcm.subarray(offset, Math.min(offset + 6400, pcm.length));
            socket.send(chunk);
            sentBytes += chunk.length;
            await new Promise(done => setTimeout(done, chunk.length / 32));
          }
          if (!finished) socket.send(JSON.stringify({ type: 'end' }));
        } catch { fail('腾讯云音频上传中断'); }
      }
      const result = data.result;
      if (typeof result?.voice_text_str === 'string' && result.voice_text_str.length) {
        sentences.set(Number(result.index || 0), result.voice_text_str);
      }
      if (data.final === 1 && !finished) {
        finished = true; clearTimeout(timeout); socket.close();
        resolve([...sentences.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join(''));
      }
    });
    socket.addEventListener('error', () => fail('无法连接腾讯云语音识别'));
    socket.addEventListener('close', () => { clearTimeout(timeout); if (!finished) fail('腾讯云连接提前关闭'); });
  });
}

async function handleTencentTranscript(req, res) {
  const body = await readJson(req);
  if (!localSettings.tencentAsr) return sendJson(res, 400, { error: '腾讯云语音识别尚未启用' });
  const encoded = String(body.audio || '');
  if (!encoded) return sendJson(res, 400, { error: '没有收到音频' });
  try {
    const transcript = await recognizeTencentPcm(Buffer.from(encoded, 'base64'));
    return sendJson(res, 200, { transcript, provider: 'tencent', engine: '16k_zh_en_2.0' });
  } catch (error) { return sendJson(res, 502, { error: error.message || '腾讯云识别失败' }); }
}

const tencentTtsCache = new Map();
const tencentTtsEndpoint = process.env.TENCENT_TTS_ENDPOINT || 'https://tts.tencentcloudapi.com';

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function hmac(key, value, encoding) { return crypto.createHmac('sha256', key).update(value).digest(encoding); }

function tencentTc3Headers(payload) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const service = 'tts'; const host = new URL(tencentTtsEndpoint).host;
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:texttovoice\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(payload)}`;
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256(canonicalRequest)}`;
  const secretDate = hmac(`TC3${localSettings.tencentSecretKey}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmac(secretSigning, stringToSign, 'hex');
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'X-TC-Action': 'TextToVoice', 'X-TC-Version': '2019-08-23', 'X-TC-Timestamp': String(timestamp),
    Authorization: `TC3-HMAC-SHA256 Credential=${localSettings.tencentSecretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function ttsText(text, limit = 145) {
  const normalized = String(text || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  if (Array.from(normalized).length <= limit) return normalized;
  const shortened = Array.from(normalized).slice(0, limit).join('');
  const boundary = Math.max(shortened.lastIndexOf('。'), shortened.lastIndexOf('！'), shortened.lastIndexOf('？'), shortened.lastIndexOf('；'));
  return boundary >= 55 ? shortened.slice(0, boundary + 1) : `${Array.from(normalized).slice(0, limit - 1).join('')}。`;
}

async function synthesizeTencent(text, voiceType, speed) {
  if (!localSettings.tencentAppId || !localSettings.tencentSecretId || !localSettings.tencentSecretKey) throw new Error('请先保存腾讯云 AppID、SecretId 和 SecretKey');
  const spokenText = ttsText(text);
  if (!spokenText) throw new Error('没有可播放的文字');
  const cacheKey = sha256(`${voiceType}|${speed}|${spokenText}`);
  if (tencentTtsCache.has(cacheKey)) return { ...tencentTtsCache.get(cacheKey), cached: true };
  const requestBody = JSON.stringify({
    Text: spokenText, SessionId: crypto.randomUUID(), Volume: 0, Speed: speed,
    ProjectId: 0, ModelType: 1, VoiceType: voiceType, PrimaryLanguage: 1, SampleRate: 16000, Codec: 'mp3',
  });
  const response = await fetch(tencentTtsEndpoint, { method: 'POST', headers: tencentTc3Headers(requestBody), body: requestBody });
  const result = await response.json().catch(() => ({}));
  const providerError = result?.Response?.Error;
  if (!response.ok || providerError || !result?.Response?.Audio) {
    const rawMessage = String(providerError?.Message || '');
    if (/tts:TextToVoice|not authorized|no permission|AuthFailure\.UnauthorizedOperation/i.test(`${providerError?.Code || ''} ${rawMessage}`)) {
      throw new Error('腾讯云密钥已保存，但子账号没有语音合成 TextToVoice 权限。请在腾讯云访问管理给这个子账号授权 tts:TextToVoice，然后再试听。');
    }
    throw new Error(rawMessage || `腾讯云语音合成返回 ${response.status}`);
  }
  const value = { audio: result.Response.Audio, mimeType: 'audio/mpeg', provider: 'tencent', voiceType, text: spokenText, cached: false };
  tencentTtsCache.set(cacheKey, value);
  if (tencentTtsCache.size > 100) tencentTtsCache.delete(tencentTtsCache.keys().next().value);
  return value;
}

async function handleTencentTts(req, res) {
  if (!localSettings.tencentTts) return sendJson(res, 400, { error: '腾讯精品语音尚未启用' });
  const body = await readJson(req);
  const voiceType = Number(body.voiceType || localSettings.tencentVoiceType || 101004);
  const speed = Math.max(-2, Math.min(6, Number(body.speed ?? 0)));
  try { return sendJson(res, 200, await synthesizeTencent(body.text, voiceType, speed)); }
  catch (error) { return sendJson(res, 502, { error: error.message || '腾讯云语音合成失败' }); }
}

function stripCodeFence(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

function parseSummary(content) {
  try {
    const value = JSON.parse(stripCodeFence(content));
    return {
      summary: String(value.summary || '').trim(), suggestion: String(value.suggestion || '').trim(),
      hypothesis: String(value.hypothesis || '').trim(), followUp: String(value.followUp || '').trim(),
      spokenAnswer: String(value.spokenAnswer || value.summary || '').trim(),
    };
  } catch { return { summary: '', suggestion: '', hypothesis: '', followUp: '', spokenAnswer: content.trim() }; }
}

function parseCorrectedText(content, fallback) {
  try {
    const value = String(JSON.parse(stripCodeFence(content)).correctedText || '').trim();
    return value && value.length <= Math.max(2000, fallback.length * 2) ? value : fallback;
  } catch { return fallback; }
}

function compactLength(text) { return text.replace(/\s|[，。！？、；：,.!?;:'"“”‘’（）()《》]/g, '').length; }

function inferAgentCompletion(answer) {
  const text = String(answer || '').trim();
  // OpenClaw occasionally performs the work but omits the protocol marker.
  // Accept only a concrete path plus an explicit completion verb; a plan alone
  // must continue through the guarded follow-up loop.
  const hasPath = /(?:\/|~\/|[A-Za-z]:[\\/])[^\s，。！？；：)）]+/.test(text);
  const hasCompletionVerb = /(已创建|创建成功|已写入|写入成功|已保存|保存成功|文件已|已经完成|完成了)/.test(text);
  return hasPath && hasCompletionVerb;
}

function fallbackSummary(fullAnswer) {
  const sentences = fullAnswer.match(/[^。！？!?\n]+[。！？!?]?/g)?.map(item => item.trim()).filter(Boolean) || [];
  const hardLimit = Math.max(48, Math.min(220, Math.floor(fullAnswer.length * .34)));
  if (sentences.length <= 2) return fullAnswer.slice(0, hardLimit);
  const scored = sentences.map((sentence, index) => ({
    sentence, index,
    score: (/(结论|核心|因此|所以|建议|应该|需要|首先|关键|风险|注意|下一步)/.test(sentence) ? 3 : 0) + (index === 0 ? 2 : 0),
  }));
  const limit = Math.min(hardLimit, Math.max(70, Math.round(fullAnswer.length * .38)));
  const chosen = [];
  for (const item of [...scored].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (chosen.reduce((sum, value) => sum + value.sentence.length, 0) >= limit) break;
    chosen.push(item);
  }
  return chosen.sort((a, b) => a.index - b.index).map(item => item.sentence).join('').slice(0, hardLimit);
}

function ensureRealSummary(fullAnswer, candidate) {
  if (!candidate) return fallbackSummary(fullAnswer);
  const fullLength = compactLength(fullAnswer);
  const summaryLength = compactLength(candidate);
  if (fullLength > 220 && summaryLength > fullLength * .42) return fallbackSummary(fullAnswer);
  if (candidate.trim() === fullAnswer.trim()) return fallbackSummary(fullAnswer);
  return candidate.slice(0, 240);
}

async function requestCompletion({ baseUrl, apiKey, body, timeoutMs = 90_000 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body), signal: controller.signal,
    });
    const raw = await response.text();
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    if (!response.ok) throw Object.assign(new Error(payload?.error?.message || `模型服务返回 ${response.status}`), { status: response.status });
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) throw Object.assign(new Error('模型没有返回有效内容，请重试。'), { status: 502 });
    return content.trim();
  } finally { clearTimeout(timeout); }
}

async function handleOpenClaw(req, res, body) {
  const controller = new AbortController();
  let stopReason = '';
  const stop = reason => { stopReason = reason; controller.abort(); };
  const total = setTimeout(() => stop('任务等待超过180秒'), 180_000);
  let idle;
  const heartbeat = () => { clearTimeout(idle); idle = setTimeout(() => stop('任务连续60秒没有返回数据'), 60_000); };
  const disconnected = () => { if (!res.writableEnded) stop('手机连接已断开'); };
  res.on('close', disconnected);
  heartbeat();
  try {
    const token = process.env.OPENCLAW_TOKEN;
    if (!token) throw new Error('OpenClaw访问令牌未配置');
    const base = process.env.OPENCLAW_BASE_URL.replace(/\/+$/, '').replace(/\/v1$/, '');
    const messages = (Array.isArray(body.messages) ? body.messages : []).slice(-20)
      .filter(m => ['user', 'assistant'].includes(m.role))
      .map(m => ({ role: m.role, content: String(m.content || '').slice(0, 20000) }));
    if (!messages.length) throw new Error('任务内容为空');
    const system = '你通过远程API接收任务。能完成的工作请直接调用工具完成，不要只描述计划。简单任务自己执行，不调用子Agent。不得重复执行已成功的步骤。创建、写入、修改或读取文件的任务，必须先实际调用工具并核对结果，再回复文件路径、实际结果和完成说明；只说准备做什么不算完成。若确需派发子任务，请等待实际结果。只有任务真正完成、结果或文件路径已核实后，才在最后一行单独输出[TASK_DONE]；计划或未完成时不得输出。失败如实说明。';
    let previousAnswer = '';
    let outputSize = 0;
    for (let turn = 0; turn < 3; turn++) {
    heartbeat();
    const upstream = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'openclaw', messages: [{ role: 'system', content: system }, ...messages], stream: true }), signal: controller.signal,
    });
    if (!upstream.ok) throw new Error(`OpenClaw HTTP ${upstream.status}`);
    let buffer = '', answer = '', completed = false;
    const decoder = new TextDecoder();
    const consume = line => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { completed = true; return; }
      if (!data) return;
      const chunk = JSON.parse(data);
      if (chunk.error) throw new Error('OpenClaw返回执行错误');
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason === 'stop') completed = true;
      else if (choice?.finish_reason) throw new Error(`OpenClaw未正常完成：${choice.finish_reason}`);
      const piece = choice?.delta?.content;
      if (typeof piece === 'string') { answer += piece; outputSize += piece.length; }
      if (outputSize > 100000) throw new Error('任务输出超过上限，已停止等待');
      const tail = answer.slice(-480);
      if (tail.length === 480 && tail.slice(0,120) === tail.slice(120,240)
          && tail.slice(0,120) === tail.slice(240,360) && tail.slice(0,120) === tail.slice(360))
        throw new Error('检测到连续重复输出，已停止等待');
    };
    for await (const bytes of upstream.body) {
      heartbeat(); buffer += decoder.decode(bytes, { stream: true });
      if (buffer.length > 1000000) throw new Error('流式数据超过上限');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0,end).replace(/\r$/, '')); buffer = buffer.slice(end+1); }
      if (completed) break;
    }
    buffer += decoder.decode();
    if (!completed && buffer.trim()) consume(buffer.trim());
    if (!completed || !answer.trim()) throw new Error('执行流未完整结束或没有结果');
    await upstream.body.cancel();
    answer = answer.trim();
    const lines = answer.split(/\r?\n/);
    if (lines.at(-1).trim() === '[TASK_DONE]') {
      const visible = lines.slice(0, -1).join('\n').trim();
      if (!visible) throw new Error('只有完成标记，没有可交付结果');
      return sendJson(res, 200, { fullAnswer: visible, model: 'openclaw', provider: 'openclaw', completion: 'agent_declared', turns: turn + 1 });
    }
    if (inferAgentCompletion(answer)) {
      return sendJson(res, 200, { fullAnswer: answer, model: 'openclaw', provider: 'openclaw', completion: 'inferred_concrete_result', turns: turn + 1 });
    }
    if (answer === previousAnswer) throw new Error('检测到跨轮重复回复，已停止续接');
    if (turn === 2) throw new Error('两次续接后仍未收到任务完成标记，已停止');
    previousAnswer = answer;
    messages.push({ role: 'assistant', content: answer }, { role: 'user', content: '继续同一个任务。先检查已经完成的步骤，不要重复创建、修改或提交；只完成剩余工作并返回实际结果。失败请直接说明。真正完成后在最后一行单独输出[TASK_DONE]。' });
    }

  } catch (error) {
    controller.abort();
    if (!res.destroyed) return sendJson(res, 502, { error: `${stopReason || error.message}；未自动重发。远端执行状态待确认，请勿重复提交同一任务。` });
  } finally {
    controller.abort(); clearTimeout(total); clearTimeout(idle); res.off('close', disconnected);
  }
}

async function handleChat(req, res) {
  const body = await readJson(req);
  if (process.env.OPENCLAW_BASE_URL) return handleOpenClaw(req, res, body);
  const apiKey = String(req.headers['x-api-key'] || localSettings.apiKey || '').trim();
  if (!apiKey) return sendJson(res, 401, { error: '还没有设置 DeepSeek API Key，请打开右上角设置。' });

  const baseUrl = String(body.baseUrl || localSettings.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = String(body.model || localSettings.model || 'deepseek-v4-pro');
  const mode = body.mode === 'deep' ? 'deep' : 'normal';
  const history = Array.isArray(body.messages) ? body.messages.slice(-30) : [];
  const modePrompt = mode === 'deep'
    ? '\n当前为深度模式：允许更充分地推理、比较方案和指出风险，但 spokenAnswer 仍要适合听。'
    : '\n当前为快速模式：优先清晰、直接和实用。';

  try {
    const requestBody = {
      model,
      thinking: { type: mode === 'deep' ? 'enabled' : 'disabled' },
      messages: [
        { role: 'system', content: `${basePrompt}\n今天是 ${new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long', timeZone: 'Asia/Shanghai' }).format(new Date())}。${modePrompt}` },
        ...history.filter(item => ['user', 'assistant'].includes(item.role)).map(item => ({
          role: item.role,
          content: String(item.content || '').slice(0, 20_000),
        })),
      ],
    };
    if (mode === 'deep') requestBody.reasoning_effort = 'high';
    else requestBody.temperature = 0.65;
    const fullAnswer = await requestCompletion({ baseUrl, apiKey, body: requestBody });
    return sendJson(res, 200, { fullAnswer, model });
  } catch (error) {
    const message = error.name === 'AbortError' ? '模型响应超时，请重试。' : error.status ? error.message : `无法连接模型服务：${error.message || '请检查网络和接口地址'}`;
    return sendJson(res, error.status || 502, { error: error.status ? error.message : message });
  }
}

async function handleSummarize(req, res) {
  const body = await readJson(req);
  const apiKey = String(req.headers['x-api-key'] || localSettings.apiKey || '').trim();
  if (!apiKey) return sendJson(res, 401, { error: '还没有设置 DeepSeek API Key。' });
  const fullAnswer = String(body.fullAnswer || '').trim();
  const question = String(body.question || '').trim();
  if (!fullAnswer) return sendJson(res, 400, { error: '没有可总结的完整回答。' });
  const baseUrl = String(body.baseUrl || localSettings.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = String(body.model || localSettings.model || 'deepseek-v4-pro');
  try {
    const content = await requestCompletion({
      baseUrl, apiKey, timeoutMs: 60_000,
      body: {
        model,
        thinking: { type: 'disabled' },
        temperature: 0.2,
        max_tokens: 900,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: summaryPrompt },
          { role: 'user', content: `用户的问题：${question}\n\n完整回答：\n${fullAnswer}` },
        ],
      },
    });
    const parsed = parseSummary(content);
    return sendJson(res, 200, {
      ...parsed,
      summary: parsed.summary || fallbackSummary(fullAnswer),
      spokenAnswer: ensureRealSummary(fullAnswer, parsed.spokenAnswer), model,
    });
  } catch {
    // 语音摘要失败不应让已经完成的主回答丢失。
    const fallback = fallbackSummary(fullAnswer);
    return sendJson(res, 200, { summary: fallback, suggestion: '', hypothesis: '', followUp: '继续深入分析这个问题', spokenAnswer: fallback, model, fallback: true });
  }
}

async function handleTranscript(req, res) {
  const body = await readJson(req);
  const apiKey = String(req.headers['x-api-key'] || localSettings.apiKey || '').trim();
  if (!apiKey) return sendJson(res, 401, { error: '还没有设置 DeepSeek API Key，已保留原始识别结果。' });
  const transcript = String(body.transcript || '').trim();
  if (!transcript) return sendJson(res, 200, { correctedText: '' });
  const context = String(body.context || '').slice(-4000);
  const baseUrl = String(body.baseUrl || localSettings.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = String(body.model || localSettings.model || 'deepseek-v4-pro');
  try {
    const content = await requestCompletion({
      baseUrl, apiKey, timeoutMs: 30_000,
      body: {
        model,
        thinking: { type: 'disabled' },
        temperature: 0,
        max_tokens: 700,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: transcriptPrompt },
          { role: 'user', content: `最近对话：\n${context}\n\n语音识别原文：\n${transcript}` },
        ],
      },
    });
    return sendJson(res, 200, { correctedText: parseCorrectedText(content, transcript), originalText: transcript });
  } catch {
    return sendJson(res, 200, { correctedText: transcript, originalText: transcript, fallback: true });
  }
}

async function handleThreadSearch(req, res) {
  const body = await readJson(req);
  const apiKey = String(req.headers['x-api-key'] || localSettings.apiKey || '').trim();
  if (!apiKey) return sendJson(res, 401, { error: '还没有设置 DeepSeek API Key。' });
  const query = String(body.query || '').trim();
  const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 40) : [];
  if (!query || !candidates.length) return sendJson(res, 200, { selectedThreadId: '' });
  const safeCandidates = candidates.map(item => ({
    id: String(item.id || ''),
    title: String(item.title || '').slice(0, 120),
    updatedAt: Number(item.updatedAt || 0),
    content: String(item.content || '').slice(0, 5000),
  })).filter(item => item.id);
  const baseUrl = String(body.baseUrl || localSettings.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = String(body.model || localSettings.model || 'deepseek-v4-pro');
  try {
    const content = await requestCompletion({
      baseUrl, apiKey, timeoutMs: 30_000,
      body: {
        model,
        thinking: { type: 'disabled' },
        temperature: 0,
        max_tokens: 350,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: threadSearchPrompt },
          { role: 'user', content: `检索要求：${query}\n\n候选会话：\n${JSON.stringify(safeCandidates)}` },
        ],
      },
    });
    let parsed = {};
    try { parsed = JSON.parse(stripCodeFence(content)); } catch {}
    const selectedThreadId = String(parsed.selectedThreadId || '');
    const valid = safeCandidates.some(item => item.id === selectedThreadId);
    return sendJson(res, 200, { selectedThreadId: valid ? selectedThreadId : '', reason: String(parsed.reason || '') });
  } catch {
    return sendJson(res, 200, { selectedThreadId: '', fallback: true });
  }
}

async function handleInterpretCommand(req, res) {
  const body = await readJson(req);
  const apiKey = String(req.headers['x-api-key'] || localSettings.apiKey || '').trim();
  if (!apiKey) return sendJson(res, 401, { error: '还没有设置 DeepSeek API Key。' });
  const text = String(body.text || '').trim();
  if (!text) return sendJson(res, 200, { newTopic: false, mode: 'keep', resumeQuery: '', prompt: '' });
  const baseUrl = String(body.baseUrl || localSettings.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = String(body.model || localSettings.model || 'deepseek-v4-pro');
  try {
    const content = await requestCompletion({
      baseUrl, apiKey, timeoutMs: 25_000,
      body: {
        model, thinking: { type: 'disabled' }, temperature: 0, max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: commandRouterPrompt }, { role: 'user', content: text }],
      },
    });
    let parsed = {}; try { parsed = JSON.parse(stripCodeFence(content)); } catch {}
    const mode = ['fast', 'deep'].includes(parsed.mode) ? parsed.mode : 'keep';
    return sendJson(res, 200, {
      newTopic: parsed.newTopic === true,
      mode,
      resumeQuery: String(parsed.resumeQuery || '').trim().slice(0, 1000),
      prompt: String(parsed.prompt ?? text).trim(),
    });
  } catch (error) {
    return sendJson(res, 502, { error: error.message || '指令理解失败' });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
  try {
    const data = await readFile(join(root, safePath));
    res.writeHead(200, {
      'Content-Type': mime[extname(safePath)] || 'application/octet-stream',
      // 本地原型频繁迭代，禁止浏览器继续运行旧版交互脚本。
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const requestPath = new URL(req.url, 'http://localhost').pathname;
    if (requestPath.startsWith('/api/') && requestPath !== '/api/health' && !authorized(req)) return sendJson(res, 401, { error: '应用访问令牌无效或缺失' });
    if (requestPath.startsWith('/api/') && requestPath !== '/api/health' && !['GET', 'POST'].includes(req.method)) return sendJson(res, 405, { error: '接口不支持此请求方式' });
    if (remoteMode && requestPath === '/api/settings') return sendJson(res, 403, { error: '远程模式禁止访问模型与语音密钥设置，请由服务器管理员配置' });
    if (remoteMode && req.headers['x-api-key']) return sendJson(res, 400, { error: '远程模式由服务端管理模型密钥' });
    if (req.method === 'GET' && req.url === '/api/health') return sendJson(res, 200, { ok: true, version: appVersion });
    if (req.method === 'GET' && req.url === '/api/status') return sendJson(res, 200, {
      ok: true, version: appVersion,
      model: { configured: Boolean(String(localSettings.apiKey || '').trim()), name: String(localSettings.model || ''), baseUrlConfigured: Boolean(String(localSettings.baseUrl || '').trim()) },
      asr: { enabled: Boolean(localSettings.tencentAsr), credentialsConfigured: Boolean(localSettings.tencentAppId && localSettings.tencentSecretId && localSettings.tencentSecretKey) },
      tts: { enabled: Boolean(localSettings.tencentTts), credentialsConfigured: Boolean(localSettings.tencentAppId && localSettings.tencentSecretId && localSettings.tencentSecretKey) },
    });
    if (req.method === 'GET' && req.url === '/api/settings') return sendJson(res, 200, publicSettings());
    if (req.method === 'POST' && req.url === '/api/settings') return await saveLocalSettings(req, res);
    if (req.method === 'POST' && req.url === '/api/chat') return await handleChat(req, res);
    if (req.method === 'POST' && req.url === '/api/summarize') return await handleSummarize(req, res);
    if (req.method === 'POST' && req.url === '/api/transcript') return await handleTranscript(req, res);
    if (req.method === 'POST' && req.url === '/api/tencent-transcript') return await handleTencentTranscript(req, res);
    if (req.method === 'POST' && req.url === '/api/tencent-tts') return await handleTencentTts(req, res);
    if (req.method === 'POST' && req.url === '/api/search-threads') return await handleThreadSearch(req, res);
    if (req.method === 'POST' && req.url === '/api/interpret-command') return await handleInterpretCommand(req, res);
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res);
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    sendJson(res, 400, { error: error.message || '请求失败' });
  }
});

server.listen(port, host, () => {
  console.log(`Press to Think: http://localhost:${port}`);
});
