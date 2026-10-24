import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'squidring-access-'));
const settingsPath = join(directory, 'settings.json');
const received = [];
const upstream = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  received.push(JSON.parse(raw));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: '受保护后端测试通过。' } }] }));
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const root = fileURLToPath(new URL('../', import.meta.url));
const token = randomBytes(32).toString('hex');
let app; let stderr = '';
async function start(settings, port, remote = true) {
  await writeFile(settingsPath, JSON.stringify(settings));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), REMOTE_MODE: remote ? '1' : '0', APP_ACCESS_TOKEN: remote ? token : '', SETTINGS_PATH: settingsPath } });
  let childError = ''; child.stderr.on('data', value => { childError += value; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('后端启动超时')), 5000);
      child.stdout.on('data', data => { if (String(data).includes('Press to Think')) { clearTimeout(timer); resolve(); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(childError || '后端提前退出')); });
    });
    return child;
  } catch (error) { child.kill('SIGTERM'); throw error; }
}
function request(base, path, body, access, extra = {}, method) {
  return fetch(base + path, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', ...(access ? { 'X-App-Token': access } : {}), ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function stop(child) { if (!child) return; child.kill('SIGTERM'); if (child.exitCode === null) await once(child, 'exit'); }
try {
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  app = await start({ apiKey: 'fixture-only', model: 'server-model', baseUrl: upstreamUrl, tencentAsr: false, tencentTts: false }, 41108);
  const base = 'http://127.0.0.1:41108';
  assert.equal((await request(base, '/api/health')).status, 200);
  assert.equal((await request(base, '/api/status')).status, 401, 'diagnostic status requires authorization');
  assert.equal((await request(base, '/api/status', null, 'invalid')).status, 401);
  assert.equal((await request(base, '/api/settings')).status, 401, 'unauthenticated settings do not reveal backend configuration');
  assert.equal((await request(base, '/api/status', null, token, {}, 'PUT')).status, 405, 'API verbs are restricted');
  assert.equal((await request(base, '/api/status', null, token).then(response => response.status)), 200);
  const status = await request(base, '/api/status', null, token).then(response => response.json());
  assert.deepEqual(status, { ok: true, version: '2.0.0', model: { configured: true, name: 'server-model', baseUrlConfigured: true }, asr: { enabled: false, credentialsConfigured: false }, tts: { enabled: false, credentialsConfigured: false } });
  assert.equal((await request(base, '/api/chat', { messages: [] })).status, 401);
  assert.equal((await request(base, '/api/chat', { messages: [] }, 'invalid')).status, 401);
  assert.equal((await request(base, '/api/settings', null, token)).status, 403);
  assert.equal((await request(base, '/api/settings', { apiKey: 'must-not-save' }, token)).status, 403);
  assert.equal((await request(base, '/api/chat', { messages: [] }, token, { 'X-API-Key': 'must-not-forward' })).status, 400);
  const result = await request(base, '/api/chat', { baseUrl: 'http://127.0.0.1:1', model: 'client-override', apiKey: 'client-key', messages: [{ role: 'user', content: 'test' }] }, token);
  assert.equal(result.status, 200); assert.equal((await result.json()).fullAnswer, '受保护后端测试通过。');
  assert.equal(received.length, 1); assert.equal(received[0].model, 'server-model');
  await stop(app); app = null;

  const weak = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: '41109', REMOTE_MODE: '1', APP_ACCESS_TOKEN: '', SETTINGS_PATH: settingsPath }, stdio: 'ignore' });
  const [code] = await once(weak, 'exit'); assert.notEqual(code, 0);

  app = await start({ apiKey: 'fixture-local-key', model: 'deepseek-v4-pro', baseUrl: upstreamUrl, tencentAppId: '', tencentSecretId: '', tencentSecretKey: '', tencentAsr: false, tencentTts: false }, 41110, false);
  const local = 'http://127.0.0.1:41110';
  assert.equal((await request(local, '/api/status')).status, 200, 'local desktop app can read diagnostic status');
  assert.equal((await request(local, '/api/chat', { messages: [] }, null, { 'X-API-Key': 'fixture-browser-key' })).status, 200, 'local desktop browser keeps its existing API flow');
  const localStatus = await request(local, '/api/status').then(response => response.json());
  assert.deepEqual(localStatus.model, { configured: true, name: 'deepseek-v4-pro', baseUrlConfigured: true });
  assert.deepEqual(localStatus.asr, { enabled: false, credentialsConfigured: false });
  assert.deepEqual(localStatus.tts, { enabled: false, credentialsConfigured: false });
  await stop(app); app = null;
  app = await start({ apiKey: '', model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com', tencentAppId: '', tencentSecretId: '', tencentSecretKey: '', tencentAsr: false, tencentTts: false }, 41111, false);
  const unset = await request('http://127.0.0.1:41111', '/api/status').then(response => response.json());
  assert.deepEqual(unset.model, { configured: false, name: 'deepseek-v4-pro', baseUrlConfigured: true });
  assert.deepEqual(unset.asr, { enabled: false, credentialsConfigured: false });
  assert.deepEqual(unset.tts, { enabled: false, credentialsConfigured: false });

  console.log(JSON.stringify({ ok: true, checks: ['protected-status', 'credential-free-status', 'settings-protected', 'method-restricted', 'provider-overrides-ignored', 'weak-token-refused', 'local-app-regression', 'unset-model-asr-tts'] }));
} finally {
  await stop(app);
  await new Promise(resolve => upstream.close(resolve));
  await unlink(settingsPath).catch(() => {}); await rmdir(directory).catch(() => {});
}
