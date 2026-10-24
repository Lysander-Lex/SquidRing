const $ = selector => document.querySelector(selector);
let state = { threads: [], pendingNewTopic: true, status: 'idle' };
let renderedMessages = '';
const call = (action, value = '') => {
  if (window.SquidNative) window.SquidNative.command(action, String(value));
  else toast('此界面需要在安卓应用中运行');
};
const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('show'), 2600); }
function openDrawer(id) { closeDrawers(); $('#' + id).classList.add('open'); $('#' + id).setAttribute('aria-hidden', 'false'); $('#backdrop').classList.add('show'); }
function closeDrawers() { document.querySelectorAll('.drawer,.record-sheet').forEach(node => { node.classList.remove('open'); node.setAttribute('aria-hidden', 'true'); }); $('#backdrop').classList.remove('show'); }
window.closeDrawers = closeDrawers;
const emptyMarkup = $('#messages').innerHTML;
const statusCopy = {
  idle: ['READY', '准备好聆听', '按住戒指说话 · 双击听摘要'],
  listening: ['LISTENING', '正在聆听', '松开戒指按钮后发送'],
  thinking: ['THINKING', '正在思考', '长按戒指可以打断并重新提问'],
  ready: ['ANSWER READY', '回答已准备好', '双击戒指听摘要'],
  speaking: ['SPEAKING', '正在播放', '长按戒指停止播放并继续说'],
  error: ['CHECK', '操作未完成', '查看提示后重试'],
};
window.receiveState = snapshot => {
  state = snapshot;
  const current = state.pendingNewTopic ? null : state.threads.find(t => t.id === state.currentThreadId);
  const messages = current?.messages || [];
  $('#threadTitle').textContent = current?.title || '新话题';
  $('#messageCount').textContent = `${messages.length} 条`;
  $('#modeLabel').textContent = `${state.deepMode ? '深度' : '快速'}模式`;
  $('#connectionLabel').textContent = state.connected ? '戒指已连接' : '戒指未连接';
  $('.connection-dot').classList.toggle('offline', !state.connected);
  $('.ring-card small').textContent = `${state.connected ? '已连接' : '未连接'} · 电量未知`;
  $('#deviceStatus').textContent = state.connection || '戒指未连接';
  $('#serviceDiagnostics').textContent = state.status === 'thinking' && state.detail.startsWith('正在检查服务配置') ? state.detail : $('#serviceDiagnostics').textContent;
  if (state.detail.startsWith('后端可访问；') || state.detail.startsWith('后端不可用：')) $('#serviceDiagnostics').textContent = state.detail;
  else if (state.status === 'error' && state.detail.startsWith('远程后端')) $('#serviceDiagnostics').textContent = state.detail;
  $('#backgroundStatus').textContent = state.batteryExempt ? '已允许不受电池优化限制；仍需完成锁屏实测。' : '长时间锁屏使用，请在系统中允许后台运行并检查电池优化设置。';
  if (!$('#settingsDrawer').classList.contains('open')) syncSettings();
  const copy = statusCopy[state.status] || statusCopy.idle;
  $('#statusKicker').textContent = copy[0]; $('#statusTitle').textContent = copy[1]; $('#statusHint').textContent = state.detail || copy[2];
  $('#liveTranscript').textContent = state.status === 'error' ? state.detail : '';
  document.body.className = ['listening', 'thinking', 'speaking'].includes(state.status) ? state.status : '';
  const signature = JSON.stringify([state.currentThreadId, state.pendingNewTopic, messages]);
  if (signature !== renderedMessages) {
    renderedMessages = signature;
    $('#messages').innerHTML = messages.length ? messages.map(m => `<article class="message ${m.role === 'assistant' ? 'assistant' : 'user'}"><div class="message-meta"><span>${m.role === 'assistant' ? 'PRESS TO THINK' : 'YOU'}</span><time>${new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div><div class="message-body">${escape(m.content)}</div>${m.summary ? `<div class="thought-card"><span>THOUGHT SUMMARY</span><h4>${escape(m.summary)}</h4>${m.suggestion ? `<p>建议：${escape(m.suggestion)}</p>` : ''}${m.hypothesis ? `<p>待验证：${escape(m.hypothesis)}</p>` : ''}</div>` : ''}${m.role === 'assistant' && m.spoken ? '<button type="button" class="audio-play" data-play>播放最新摘要</button>' : ''}${m.audioPath ? `<details><summary>原始输入</summary><button class="audio-play" data-recording="${escape(m.id)}" type="button">播放原始录音</button><p>${escape(m.originalTranscript)}</p></details>` : ''}${m.followUp ? `<button class="follow-up" type="button" data-follow="${escape(m.followUp)}">${escape(m.followUp)}</button>` : ''}</article>`).join('') : emptyMarkup;
    $('#messages').scrollTop = $('#messages').scrollHeight;
  }
  $('#threadList').innerHTML = [...state.threads].sort((a, b) => b.updatedAt - a.updatedAt).map(t => `<button type="button" class="thread-item ${!state.pendingNewTopic && t.id === state.currentThreadId ? 'active' : ''}" data-thread="${escape(t.id)}"><strong>${escape(t.title)}</strong><span>${t.messages.length} 条 · ${new Date(t.updatedAt).toLocaleDateString('zh-CN')}</span></button>`).join('');
};
function syncSettings() { $('#backendUrlInput').value = state.backendUrl || 'http://127.0.0.1:3210'; $('#deviceAddressInput').value = state.deviceAddress || ''; $('#deepModeInput').checked = Boolean(state.deepMode); }
$('#chatNav').onclick = () => { renderedMessages = ''; window.receiveState(state); };
$('#historyButton').onclick = () => openDrawer('historyDrawer');
$('#settingsButton').onclick = () => { syncSettings(); openDrawer('settingsDrawer'); };
$('#newTopicButton').onclick = $('#drawerNewTopic').onclick = () => { call('newTopic'); closeDrawers(); };
$('#backdrop').onclick = closeDrawers;
document.querySelectorAll('[data-close]').forEach(node => node.onclick = closeDrawers);
$('#textForm').onsubmit = event => { event.preventDefault(); const value = $('#textInput').value.trim(); if (value) { call('submit', value); $('#textInput').value = ''; } };
$('#textInput').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#textForm').requestSubmit(); } };
$('#threadList').onclick = event => { const node = event.target.closest('[data-thread]'); if (node) { call('select', node.dataset.thread); closeDrawers(); } };
$('#messages').onclick = event => {
  const recording = event.target.closest('[data-recording]'); if (recording) call('recording', recording.dataset.recording);
  if (event.target.closest('[data-play]')) call('play');
  const follow = event.target.closest('[data-follow]'); if (follow) call('submit', follow.dataset.follow);
};
let tap = 0;
$('#pttButton').onclick = () => { const now = Date.now(); if (state.status === 'speaking') { call('stop'); return; } if (now - tap < 450) { call('play'); tap = 0; } else { tap = now; toast('请按住实体戒指说话；双击此按钮可播放摘要'); } };
$('#recordButton').onclick = $('#recordingsNav').onclick = () => {
  const recordings = state.threads.flatMap(t => t.messages.filter(m => m.audioPath));
  if (!recordings.length) { toast('戒指提问的原音会保存在手机，当前还没有录音'); return; }
  $('#messages').innerHTML = recordings.map(m => `<article class="message"><div class="message-meta">${new Date(m.createdAt).toLocaleString('zh-CN')}</div><div class="message-body">${escape(m.content)}</div><button class="audio-play" data-recording="${escape(m.id)}" type="button">播放原始录音</button></article>`).join('');
  renderedMessages = ''; $('#threadTitle').textContent = '录音';
};
$('#tasksNav').onclick = () => toast('当前版本支持语音对话；外部任务执行尚未接入');
$('#closeRecordSheet').onclick = closeDrawers;
$('#connectRing').onclick = () => call('connect');
$('#disconnectRing').onclick = () => call('disconnect');
$('#associateRing').onclick = () => call('associate');
$('#checkBackend').onclick = () => call('check');
$('#batterySettings').onclick = () => call('battery');
$('#appSettings').onclick = () => call('appSettings');
$('#settingsForm').onsubmit = event => { event.preventDefault(); call('save', JSON.stringify({ backendUrl: $('#backendUrlInput').value.trim(), deviceAddress: $('#deviceAddressInput').value.trim(), token: $('#tokenInput').value, deepMode: $('#deepModeInput').checked })); $('#tokenInput').value = ''; };
