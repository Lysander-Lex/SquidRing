import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fullAnswer = '结论是应该先验证核心交互，而不是继续增加功能。第一，长按输入必须稳定，这是产品存在的基础。第二，回答完成后由用户双击播放，可以避免打断音乐。第三，完整内容保留在手机里，方便之后查看。除此之外，账号系统、社交功能和复杂的模型市场现在都不是重点。下一步应该先测试二十次连续录音，记录成功率、响应时间和用户是否愿意重复使用。';
const received = [];
const ttsReceived = [];
const testSettingsPath = join(projectRoot, 'data', 'settings.test.json');

const upstream = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  if (req.headers['x-tc-action'] === 'TextToVoice') {
    ttsReceived.push({ body, authorization: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body.Text.includes('权限错误测试')
      ? { Response: { Error: { Code: 'AuthFailure.UnauthorizedOperation', Message: 'you are not authorized to perform operation (tts:TextToVoice) resource (*) has no permission' }, RequestId: 'tts-denied' } }
      : { Response: { Audio: Buffer.from('fake-mp3').toString('base64'), SessionId: body.SessionId, RequestId: 'tts-test' } }));
    return;
  }
  received.push(body);
  const isSummary = body.messages?.[0]?.content?.includes('语音内容编辑');
  const isRouter = body.messages?.[0]?.content?.includes('语音指令路由器');
  const content = isRouter
    ? JSON.stringify({ newTopic: true, mode: 'deep', resumeQuery: '', prompt: '分析机器狗能否实现情绪互动。' })
    : isSummary ? JSON.stringify({ spokenAnswer: fullAnswer }) : fullAnswer;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
});

await new Promise(resolve => upstream.listen(41099, '127.0.0.1', resolve));
const app = spawn(process.execPath, ['server.mjs'], { cwd: projectRoot, env: { ...process.env, PORT: '41098', TENCENT_TTS_ENDPOINT: 'http://127.0.0.1:41099', SETTINGS_PATH: testSettingsPath } });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('应用启动超时')), 5000);
  app.stdout.on('data', data => { if (String(data).includes('Press to Think')) { clearTimeout(timer); resolve(); } });
  app.once('error', reject);
});

try {
  const headers = { 'Content-Type': 'application/json', 'X-API-Key': 'test-key' };
  const savedSettings = await fetch('http://127.0.0.1:41098/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tencentAppId: '1250000000', tencentSecretId: 'AKIDTEST', tencentSecretKey: 'SECRETTEST', tencentTts: true, tencentVoiceType: 101004 }) }).then(response => response.json());
  assert.equal(savedSettings.tencentAppId, '1250000000');
  assert.equal(savedSettings.tencentTts, true);
  assert.equal(savedSettings.hasTencentTts, true);
  assert.equal('tencentSecretKey' in savedSettings, false, '服务端不得把 SecretKey 回传浏览器');
  const reloadedSettings = await fetch('http://127.0.0.1:41098/api/settings', { cache: 'no-store' }).then(response => response.json());
  assert.equal(reloadedSettings.tencentAppId, '1250000000', '刷新后 AppID 必须仍然存在');
  assert.equal(reloadedSettings.tencentTts, true, '刷新后腾讯 TTS 开关必须仍然开启');
  const staticResponse = await fetch('http://127.0.0.1:41098/app.js');
  assert.match(staticResponse.headers.get('cache-control') || '', /no-store/, '前端脚本必须禁用缓存，避免继续运行旧交互');
  const appScript = await staticResponse.text();
  assert.match(appScript, /if \(!\$\('#settingsDrawer'\)\.classList\.contains\('open'\)\) syncSettingsUI\(\)/, '自动轮询不得覆盖打开的设置表单');
  assert.match(appScript, /window\.PTTAndroid\.startCapture\(\)/, '安卓版长按必须调用原生收音');
  assert.match(appScript, /window\.PTTAndroid\.stopCapture\(\)/, '安卓版松开必须停止原生收音');
  assert.match(appScript, /\/api\/tencent-transcript/, '安卓版录音必须进入腾讯 ASR 链路');
  const html = await fetch('http://127.0.0.1:41098/').then(response => response.text());
  assert.match(html, /试听当前腾讯音色/, '设置页必须提供明确的腾讯 TTS 试听入口');
  assert.match(html, /<main class="app-shell">\s*<aside class="drawer history-rail"/, '会话列表必须位于主界面左侧');
  assert.match(html, /<div class="composer-row">\s*<textarea id="textInput"[\s\S]*?<button class="ptt-button" id="pttButton"[\s\S]*?<button id="sendButton"/, '语音按钮必须紧挨文字输入框和发送按钮');
  assert.doesNotMatch(html, /class="button-rig"/, '不得重新出现占据主画面的大按钮');
  const chat = await fetch('http://127.0.0.1:41098/api/chat', {
    method: 'POST', headers,
    body: JSON.stringify({ baseUrl: 'http://127.0.0.1:41099', model: 'deepseek-v4-pro', mode: 'deep', messages: [{ role: 'user', content: '我现在应该做什么？' }] }),
  }).then(response => response.json());
  assert.equal(chat.fullAnswer, fullAnswer);
  assert.equal(received[0].model, 'deepseek-v4-pro');
  assert.deepEqual(received[0].thinking, { type: 'enabled' });
  assert.equal(received[0].reasoning_effort, 'high');

  const summary = await fetch('http://127.0.0.1:41098/api/summarize', {
    method: 'POST', headers,
    body: JSON.stringify({ baseUrl: 'http://127.0.0.1:41099', model: 'deepseek-v4-pro', question: '我现在应该做什么？', fullAnswer }),
  }).then(response => response.json());
  assert.ok(summary.spokenAnswer.length < fullAnswer.length * .7, '复读全文时应触发压缩兜底');
  assert.ok(summary.spokenAnswer.length <= 240, '播放摘要不得退化成全文朗读');
  assert.equal(received[1].response_format.type, 'json_object');
  const routed = await fetch('http://127.0.0.1:41098/api/interpret-command', {
    method: 'POST', headers,
    body: JSON.stringify({ baseUrl: 'http://127.0.0.1:41099', model: 'deepseek-v4-pro', text: '你帮我开一个新话题，然后用深度模式分析机器狗。' }),
  }).then(response => response.json());
  assert.deepEqual(routed, { newTopic: true, mode: 'deep', resumeQuery: '', prompt: '分析机器狗能否实现情绪互动。' });
  const firstTts = await fetch('http://127.0.0.1:41098/api/tencent-tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '这是腾讯精品语音测试。', voiceType: 101004 }) }).then(response => response.json());
  const secondTts = await fetch('http://127.0.0.1:41098/api/tencent-tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '这是腾讯精品语音测试。', voiceType: 101004 }) }).then(response => response.json());
  assert.equal(firstTts.provider, 'tencent');
  assert.equal(firstTts.audio, Buffer.from('fake-mp3').toString('base64'));
  assert.equal(firstTts.cached, false);
  assert.equal(secondTts.cached, true, '重复播放必须命中缓存，避免重复计费');
  assert.equal(ttsReceived.length, 1, '缓存命中时不得再次请求腾讯云');
  assert.equal(ttsReceived[0].body.VoiceType, 101004);
  assert.match(ttsReceived[0].authorization || '', /^TC3-HMAC-SHA256 Credential=AKIDTEST\//, '必须使用腾讯云 TC3 签名');
  const deniedResponse = await fetch('http://127.0.0.1:41098/api/tencent-tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '权限错误测试。' }) });
  const denied = await deniedResponse.json();
  assert.equal(deniedResponse.status, 502);
  assert.match(denied.error, /子账号没有语音合成 TextToVoice 权限/, '权限错误应给出可操作的中文说明');
  console.log(JSON.stringify({ ok: true, model: received[0].model, fullLength: fullAnswer.length, summaryLength: summary.spokenAnswer.length }));
} finally {
  app.kill('SIGTERM');
  await new Promise(resolve => upstream.close(resolve));
  await unlink(testSettingsPath).catch(() => {});
}
