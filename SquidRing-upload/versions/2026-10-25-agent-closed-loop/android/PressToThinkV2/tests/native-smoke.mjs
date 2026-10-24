import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const adb = process.env.ADB || `${process.env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`}/platform-tools/adb`;
const serial = process.env.ANDROID_SERIAL || 'emulator-5554';
const calls = [];
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}'); calls.push({ path: req.url, body });
  let result = {};
  if (req.url === '/api/interpret-command') result = {
    newTopic: body.text === 'new-only', mode: body.text === 'deep-question' ? 'deep' : 'keep',
    resumeQuery: body.text === 'resume-only' ? 'first conversation' : '',
    prompt: ['new-only', 'resume-only'].includes(body.text) ? '' : body.text,
  };
  else if (req.url === '/api/search-threads') result = { selectedThreadId: body.candidates[0].id };
  else if (req.url === '/api/chat') {
    if (body.messages.at(-1).content === 'slow') await new Promise(resolve => setTimeout(resolve, 700));
    result = { fullAnswer: `原生链路测试回答：${body.messages.at(-1).content}` };
  } else if (req.url === '/api/summarize') result = { summary: '这是已完成的测试摘要。', spokenAnswer: '这是可播放的测试口语摘要。', suggestion: '', hypothesis: '', followUp: '' };
  else if (req.url === '/api/tencent-transcript') result = { transcript: '这是戒指录音测试' };
  else if (req.url === '/api/transcript') result = { correctedText: body.transcript };
  else if (req.url === '/api/status') result = { ok: true, version: 'mock-test-only', model: { configured: true, name: 'test-model', baseUrlConfigured: true }, asr: { enabled: false, credentialsConfigured: false }, tts: { enabled: false, credentialsConfigured: false } };
  else if (req.url === '/api/health') result = { ok: true, version: 'mock-test-only' };
  else if (req.url === '/api/tencent-tts') { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'mock has no voice' })); return; }
  else { res.writeHead(404); res.end('{}'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
});
server.listen(41118, '127.0.0.1'); await once(server, 'listening');
function run(args) { return new Promise((resolve, reject) => { const child = spawn(adb, ['-s', serial, ...args]); let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; }); child.once('error', reject); child.once('exit', code => code ? reject(new Error(output)) : resolve(output)); }); }
try {
  await run(['reverse', 'tcp:41118', 'tcp:41118']);
  const output = await run(['shell', 'am', 'instrument', '-w', 'com.presstothink.v2.test/com.presstothink.v2.EngineInstrumentation']);
  console.log(output); assert.match(output, /OK: native conversation/);
  assert.ok(calls.some(call => call.path === '/api/chat' && call.body.mode === 'deep'));
  const search = calls.find(call => call.path === '/api/search-threads'); assert.ok(search);
  assert.ok(search.body.candidates.every(candidate => candidate.content.length <= 5000));
  console.log(JSON.stringify({ ok: true, endpoints: [...new Set(calls.map(call => call.path))], calls: calls.length }));
} finally { await new Promise(resolve => server.close(resolve)); await run(['reverse', '--remove', 'tcp:41118']); }
