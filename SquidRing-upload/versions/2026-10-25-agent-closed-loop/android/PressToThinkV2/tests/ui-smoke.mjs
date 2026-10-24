import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const adb = process.env.ADB || `${process.env.ANDROID_HOME || `${process.env.HOME}/Library/Android/sdk`}/platform-tools/adb`;
const serial = process.env.ANDROID_SERIAL || 'emulator-5554';
const port = 41119;
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}'); let result;
  if (req.url === '/api/interpret-command') result = { newTopic: false, mode: 'keep', resumeQuery: '', prompt: body.text };
  else if (req.url === '/api/chat') result = { fullAnswer: `WebView bridge answer: ${body.messages.at(-1).content}` };
  else if (req.url === '/api/summarize') result = { summary: 'UI summary rendered.', spokenAnswer: 'Short spoken UI summary.', suggestion: '', hypothesis: '', followUp: '' };
  else if (req.url === '/api/status') result = { ok: true, version: 'ui-fixture', model: { configured: true, name: 'fixture-model', baseUrlConfigured: true }, asr: { enabled: false, credentialsConfigured: false }, tts: { enabled: false, credentialsConfigured: false } };
  else if (req.url === '/api/tencent-tts') {
    const samples = 16000 * 4; const wav = Buffer.alloc(44 + samples * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
    result = { audio: wav.toString('base64') };
  }
  else { res.writeHead(404); res.end('{}'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
});
server.listen(port, '127.0.0.1'); await once(server, 'listening');
function command(args) { return new Promise((resolve, reject) => { const child = spawn(adb, ['-s', serial, ...args]); let output = ''; child.stdout.on('data', value => output += value); child.stderr.on('data', value => output += value); child.once('error', reject); child.once('exit', code => code ? reject(new Error(`adb ${args.join(' ')} exited ${code}: ${output}`)) : resolve(output)); }); }
let socket; let sequence = 0; const waiting = new Map();
try {
  await command(['reverse', `tcp:${port}`, `tcp:${port}`]);
  await command(['shell', 'am', 'force-stop', 'com.presstothink.v2']);
  await command(['shell', 'am', 'start', '-n', 'com.presstothink.v2/.MainActivity']);
  let pid = '';
  for (let attempt = 0; attempt < 30 && !pid; attempt++) { pid = (await command(['shell', 'pidof', 'com.presstothink.v2']).catch(() => '')).trim().split(/\s+/)[0] || ''; if (!pid) await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(pid, 'application process starts');
  await command(['forward', 'tcp:9224', `localabstract:webview_devtools_remote_${pid}`]);
  let target;
  for (let attempt = 0; attempt < 30 && !target; attempt++) {
    try { const targets = await fetch('http://127.0.0.1:9224/json/list').then(response => response.json()); target = targets.find(item => item.url.endsWith('/assets/www/index.html')); } catch {}
    if (!target) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(target, 'embedded app page is inspectable');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => { const message = JSON.parse(event.data); if (message.id && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); } };
  const evaluate = expression => new Promise((resolve, reject) => {
    const id = ++sequence; const timer = setTimeout(() => { waiting.delete(id); reject(new Error('WebView evaluation timed out')); }, 5000);
    waiting.set(id, response => { clearTimeout(timer); if (response.error) reject(new Error(JSON.stringify(response.error))); else resolve(response.result?.result?.value); });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  for (let attempt = 0; attempt < 50; attempt++) { if (await evaluate(`Boolean(document.querySelector('#backendUrlInput')?.value)`)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(await evaluate(`Boolean(document.querySelector('#backendUrlInput')?.value)`), 'native service is bound and initial snapshot rendered');
  await evaluate(`window.SquidNative.command('save', JSON.stringify({backendUrl:'http://127.0.0.1:${port}',token:'',deviceAddress:'',deepMode:false}))`);
  for (let attempt = 0; attempt < 30; attempt++) { if (await evaluate(`document.querySelector('#backendUrlInput').value === 'http://127.0.0.1:${port}'`)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(await evaluate(`document.querySelector('#backendUrlInput').value`), `http://127.0.0.1:${port}`);
  await evaluate(`window.SquidNative.command('newTopic', '')`);
  for (let attempt = 0; attempt < 30; attempt++) { if (await evaluate(`document.querySelector('#threadTitle').textContent === '新话题' && document.querySelector('#backendUrlInput').value === 'http://127.0.0.1:${port}'`)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  await evaluate(`window.SquidNative.command('submit', 'WebView bridge question')`);
  let text = '';
  for (let attempt = 0; attempt < 50; attempt++) { text = await evaluate(`document.querySelector('#messages').innerText`); if (text.includes('WebView bridge answer') && text.includes('UI summary rendered.') && await evaluate(`document.querySelector('#statusKicker').textContent === 'ANSWER READY'`)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.match(text, /WebView bridge answer: WebView bridge question/);
  assert.match(text, /UI summary rendered\./);
  await evaluate(`window.SquidNative.command('check', '')`);
  let serviceStatus = '';
  for (let attempt = 0; attempt < 30; attempt++) { serviceStatus = await evaluate(`document.querySelector('#serviceDiagnostics').innerText`); if (serviceStatus.startsWith('后端')) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.match(serviceStatus, /后端可访问；模型/);
  assert.match(serviceStatus, /ASR 未启用或未配置/);
  assert.match(serviceStatus, /腾讯 TTS 未启用或未配置/);
  await evaluate(`window.SquidNative.command('play', '')`);
  for (let attempt = 0; attempt < 30; attempt++) { if (await evaluate(`document.querySelector('#statusKicker').textContent === 'SPEAKING'`)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(await evaluate(`document.querySelector('#statusKicker').textContent`), 'SPEAKING');
  const services = await command(['shell', 'dumpsys', 'activity', 'services', 'com.presstothink.v2']);
  assert.match(services, /startRequested=true/, 'playback owns a started service');
  assert.match(services, /isForeground=true/, 'playback is foreground');
  await evaluate(`window.SquidNative.command('save', JSON.stringify({backendUrl:'http://127.0.0.1:3210',token:'',deviceAddress:'',deepMode:false}))`);
  await command(['shell', 'am', 'start', '-n', 'com.presstothink.v2/.MainActivity', '--activity-clear-top']);
  const afterRecreation = await command(['shell', 'dumpsys', 'activity', 'services', 'com.presstothink.v2']);
  assert.match(afterRecreation, /startRequested=true/, 'playback service survives Activity replacement');
  assert.match(afterRecreation, /isForeground=true/);
  await command(['shell', 'am', 'force-stop', 'com.presstothink.v2']);
  console.log(JSON.stringify({ ok: true, page: target.url, answerRendered: true, summaryRendered: true, configurationDiagnostics: true, playbackStartedService: true, activityReplacement: true }));
} finally {
  if (socket) socket.close();
  await new Promise(resolve => server.close(resolve));
  await command(['reverse', '--remove', `tcp:${port}`]).catch(() => {});
  await command(['forward', '--remove', 'tcp:9224']).catch(() => {});
}
