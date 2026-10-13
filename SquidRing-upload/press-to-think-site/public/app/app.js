const $ = selector => document.querySelector(selector);
const IS_HOSTED = !['localhost', '127.0.0.1'].includes(window.location.hostname);

const STORAGE = {
  settings: 'ptt.settings.v1',
  threads: 'ptt.threads.v1',
  current: 'ptt.current.v1',
};

const defaultSettings = {
  baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro',
  deepMode: false, voiceURI: '', hasApiKey: false, keyHint: '', apiKey: '',
  tencentAsr: false, hasTencentAsr: false, tencentAppId: '', tencentKeyHint: '',
  tencentTts: false, hasTencentTts: false, tencentVoiceType: 101004,
};

function safeParse(value, fallback) {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
}

const state = {
  status: 'idle', recognition: null, isHolding: false, pressStarted: 0,
  pressTimer: null, listeningStarted: false,
  finalTranscript: '', interimTranscript: '', lastTapAt: 0, ignoreRecognitionEnd: false,
  finishTimer: null, recognitionReady: false, requestController: null,
  settings: { ...defaultSettings, ...safeParse(localStorage.getItem(STORAGE.settings), {}) },
  threads: safeParse(localStorage.getItem(STORAGE.threads), []),
  currentThreadId: localStorage.getItem(STORAGE.current), voices: [], backendOnline: false,
  mediaRecorder: null, mediaStream: null, audioChunks: [], captureStartedAt: 0,
  pendingNewTopic: false,
  activeAudio: null, activeAudioUrl: '',
};

const AUDIO_DB = 'ptt.audio.v1';
function openAudioDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(AUDIO_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('recordings');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function saveAudio(blob) {
  if (!blob?.size) return '';
  const id = crypto.randomUUID(); const db = await openAudioDB();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('recordings', 'readwrite');
    transaction.objectStore('recordings').put(blob, id);
    transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
  });
  db.close(); return id;
}
async function loadAudio(id) {
  if (!id) return null;
  const db = await openAudioDB();
  const blob = await new Promise((resolve, reject) => {
    const request = db.transaction('recordings').objectStore('recordings').get(id);
    request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error);
  });
  db.close(); return blob;
}

// 自动迁移旧版设置；旧模型别名已经不再作为默认值使用。
if (!state.settings.model || ['deepseek-chat', 'deepseek-reasoner'].includes(state.settings.model)) {
  state.settings.model = 'deepseek-v4-pro';
}
delete state.settings.normalModel;
delete state.settings.deepModel;
if (!IS_HOSTED) delete state.settings.apiKey;

if (!Array.isArray(state.threads)) state.threads = [];
// V2 早期版本可能把“问题”留在旧会话、把“答案”单独写进新会话。
// 只修复十分钟内、且内容严格为 assistant-only 的孤立会话，避免误并正常历史。
if (!localStorage.getItem('ptt.threadSplitRepair.v2')) {
  const orphans = state.threads.filter(thread => thread.messages?.length && thread.messages.every(message => message.role === 'assistant'));
  for (const orphan of orphans) {
    const firstAnswerAt = orphan.messages[0]?.createdAt || orphan.createdAt;
    const candidate = state.threads
      .filter(thread => thread.id !== orphan.id && thread.messages?.at(-1)?.role === 'user')
      .map(thread => ({ thread, gap: firstAnswerAt - (thread.messages.at(-1).createdAt || thread.updatedAt) }))
      .filter(item => item.gap >= 0 && item.gap <= 10 * 60 * 1000)
      .sort((a, b) => a.gap - b.gap)[0]?.thread;
    if (candidate) {
      candidate.messages.push(...orphan.messages);
      candidate.updatedAt = Math.max(candidate.updatedAt, orphan.updatedAt);
      state.threads = state.threads.filter(thread => thread.id !== orphan.id);
      if (state.currentThreadId === orphan.id) state.currentThreadId = candidate.id;
    }
  }
  localStorage.setItem('ptt.threadSplitRepair.v2', 'done');
}
// 清除旧版本错误创建、从未写入任何内容的空会话。
if (state.threads.some(thread => thread.messages?.length)) state.threads = state.threads.filter(thread => thread.messages?.length);
if (!state.threads.length) state.threads = [createThreadObject()];
if (!state.threads.some(thread => thread.id === state.currentThreadId)) state.currentThreadId = state.threads[0].id;

function createThreadObject() {
  return { id: crypto.randomUUID(), title: '新话题', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
}
function currentThread() { return state.threads.find(thread => thread.id === state.currentThreadId); }
function persist() {
  localStorage.setItem(STORAGE.threads, JSON.stringify(state.threads));
  localStorage.setItem(STORAGE.current, state.currentThreadId);
  const { hasApiKey, keyHint, ...safeSettings } = state.settings;
  if (!IS_HOSTED) delete safeSettings.apiKey;
  localStorage.setItem(STORAGE.settings, JSON.stringify(safeSettings));
}
function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}
function formatTime(timestamp) { return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
function showToast(message) {
  const toast = $('#toast'); toast.textContent = message; toast.classList.add('show');
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

let notificationAudioContext = null;
function prepareAnswerReadyCue() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    notificationAudioContext ||= new AudioContext();
    if (notificationAudioContext.state === 'suspended') notificationAudioContext.resume().catch(() => {});
  } catch {}
}
function playAnswerReadyCue() {
  navigator.vibrate?.([120, 70, 120]);
  try {
    prepareAnswerReadyCue();
    const context = notificationAudioContext;
    if (!context || context.state !== 'running') return;
    const start = context.currentTime + 0.01;
    [[987.77, start, 0.11], [1318.51, start + 0.1, 0.18]].forEach(([frequency, time, duration]) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(0.12, time + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.start(time); oscillator.stop(time + duration + 0.02);
    });
  } catch {}
}

const statusCopy = {
  idle: ['READY', '按住，说出你的想法', '松开发送 · 双击播放回答', 'HOLD'],
  listening: ['LISTENING', '我在听', '松开后立即提交', 'LISTEN'],
  thinking: ['THINKING', '正在整理你的想法', '仍可按住麦克风打断并重新提问', 'WAIT'],
  ready: ['ANSWER READY', '回答已经准备好', '双击麦克风播放口语总结', '2× PLAY'],
  speaking: ['SPEAKING', '正在播放回答', '按住麦克风立即打断并继续说', 'HOLD'],
  error: ['CHECK', '这里没有完成', '查看提示后重试', 'RETRY'],
};

function setStatus(status, detail = '') {
  state.status = status;
  document.body.classList.remove('listening', 'thinking', 'speaking');
  if (['listening', 'thinking', 'speaking'].includes(status)) document.body.classList.add(status);
  const copy = statusCopy[status] || statusCopy.idle;
  $('#statusKicker').textContent = copy[0]; $('#statusTitle').textContent = copy[1];
  $('#statusHint').textContent = detail || copy[2]; $('#buttonLabel').textContent = copy[3];
}

function emptyThreadMarkup(pending = false) {
  return `<div class="empty-thread"><div class="hero-ring"><span></span></div><p class="eyebrow">${pending ? 'NEW THOUGHT' : 'THINK OUT LOUD'}</p><h2>${pending ? '说出第一句话，才会创建新话题。' : '说出来，剩下的交给 Agent。'}</h2><p>${pending ? '空会话不会进入历史记录。你也可以在同一句话里切换模式并提出问题。' : '按住输入框旁的麦克风说话，也可以直接打字。切模式、新建话题和执行任务，都能在一句话里完成。'}</p><div class="capability-list"><div><svg viewBox="0 0 24 24"><path d="M4 12h4l2-7 4 14 2-7h4"/></svg><span><strong>盲操对话</strong><small>戒指双击，播放回答总结</small></span></div><div><svg viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="4"/><path d="M9 8h6M9 12h6"/></svg><span><strong>长按录音</strong><small>保留原音，自动生成纪要与待办</small></span></div><div><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/></svg><span><strong>Agent 执行</strong><small>跨模型、设备与服务完成任务</small></span></div></div></div>`;
}

function renderThread() {
  if (state.pendingNewTopic) {
    $('#threadTitle').textContent = '新话题'; $('#messageCount').textContent = '0 条';
    $('#messages').innerHTML = emptyThreadMarkup(true);
    renderThreadList(); return;
  }
  const thread = currentThread();
  $('#threadTitle').textContent = thread.title;
  $('#messageCount').textContent = `${thread.messages.length} 条`;
  const container = $('#messages');
  if (!thread.messages.length) {
    container.innerHTML = emptyThreadMarkup(false);
  } else {
    container.innerHTML = thread.messages.map(message => {
      const assistant = message.role === 'assistant';
      return `<article class="message ${message.role}">
        <div class="message-meta"><span>${assistant ? 'PRESS TO THINK' : 'YOU'}</span><time>${formatTime(message.createdAt)}</time></div>
        <div class="message-body">${escapeHtml(message.content)}</div>
        ${!assistant && (message.originalTranscript || message.audioId) ? `<details class="input-source"><summary>查看原始输入${message.audioId ? ' · 播放录音' : ''}</summary>${message.audioId ? `<button type="button" class="audio-play" data-audio="${message.audioId}">▶ 播放原始录音</button>` : ''}${message.originalTranscript ? `<p><b>原始识别</b>${escapeHtml(message.originalTranscript)}</p>` : ''}${message.correctedTranscript && message.correctedTranscript !== message.originalTranscript ? `<p><b>AI 校正</b>${escapeHtml(message.correctedTranscript)}</p>` : ''}</details>` : ''}
        ${assistant && message.summary ? `<div class="thought-card"><span>THOUGHT SUMMARY</span><h4>${escapeHtml(message.summary)}</h4>${message.suggestion ? `<p><b>建议</b>${escapeHtml(message.suggestion)}</p>` : ''}${message.hypothesis ? `<p><b>待验证假设</b>${escapeHtml(message.hypothesis)}</p>` : ''}</div>` : assistant && message.spoken ? `<div class="spoken-card"><span>PLAYBACK SUMMARY</span><p>${escapeHtml(message.spoken)}</p></div>` : ''}
      </article>`;
    }).join('');
  }
  requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
  container.querySelectorAll('.audio-play').forEach(button => button.addEventListener('click', async () => {
    const blob = await loadAudio(button.dataset.audio); if (!blob) return showToast('原始录音没有找到');
    const url = URL.createObjectURL(blob); const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url); audio.play();
  }));
  renderThreadList();
}

function renderThreadList() {
  const list = $('#threadList');
  const sorted = [...state.threads].sort((a, b) => b.updatedAt - a.updatedAt);
  list.innerHTML = sorted.map(thread => `<button class="thread-item ${!state.pendingNewTopic && thread.id === state.currentThreadId ? 'active' : ''}" data-thread="${thread.id}"><strong>${escapeHtml(thread.title)}</strong><span>${thread.messages.length} 条 · ${new Date(thread.updatedAt).toLocaleDateString('zh-CN')}</span></button>`).join('');
  list.querySelectorAll('.thread-item').forEach(button => button.addEventListener('click', () => {
    stopSpeaking(); state.pendingNewTopic = false; state.currentThreadId = button.dataset.thread; persist(); renderThread(); closeDrawers(); setStatus('idle');
  }));
}

function addMessage(role, content, spoken = '', metadata = {}, threadId = state.currentThreadId) {
  const thread = state.threads.find(item => item.id === threadId);
  if (!thread) throw new Error('目标会话不存在');
  const message = { id: crypto.randomUUID(), role, content, spoken, createdAt: Date.now(), ...metadata };
  thread.messages.push(message);
  if (role === 'user' && thread.title === '新话题') thread.title = content.replace(/[。！？!?\n]/g, ' ').trim().slice(0, 22) || '新话题';
  thread.updatedAt = Date.now(); persist();
  if (!state.pendingNewTopic && thread.id === state.currentThreadId) renderThread();
  else renderThreadList();
  return message;
}

function newTopic(announce = true) {
  stopSpeaking();
  if (state.pendingNewTopic) { if (announce) showToast('说出第一句话后才会创建'); return; }
  state.pendingNewTopic = true; renderThread(); if (announce) showToast('等待第一句话，不会创建空会话');
  setStatus('idle');
}

function commitPendingNewTopic() {
  if (!state.pendingNewTopic) return currentThread();
  const thread = createThreadObject(); state.threads.unshift(thread); state.currentThreadId = thread.id;
  state.pendingNewTopic = false; persist(); renderThread(); return thread;
}

function normalizeWords(text) { return text.toLowerCase().replace(/[，。！？、,.!?：:“”‘’的了一个之前继续讨论关于话题对话]/g, ''); }
function selectThread(thread) {
  state.pendingNewTopic = false; state.currentThreadId = thread.id; persist(); renderThread();
  showToast(`已恢复：${thread.title}`); setStatus('idle', '已经回到之前的 Thought Thread');
}
function resumePreviousByCharacters(command, candidates) {
  const query = normalizeWords(command.replace(/继续|恢复|回到|找到|之前|对话|话题/g, ''));
  const scored = candidates.map(thread => {
    const haystack = normalizeWords(`${thread.title} ${thread.messages.slice(0, 6).map(item => item.content).join(' ')}`);
    let score = 0;
    for (const char of new Set(query)) if (char && haystack.includes(char)) score += 1;
    return { thread, score };
  }).sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score < 2) return false;
  selectThread(scored[0].thread); return true;
}

async function resumePrevious(command) {
  const candidates = state.threads.filter(thread => thread.id !== state.currentThreadId && thread.messages.length);
  if (!candidates.length) return false;
  setStatus('thinking', '正在用 AI 检索历史会话…');
  const requestController = new AbortController(); state.requestController = requestController;
  try {
    const response = await fetch('/api/search-threads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: requestController.signal,
      body: JSON.stringify({
        baseUrl: state.settings.baseUrl, model: state.settings.model, query: command,
        candidates: candidates.map(thread => ({
          id: thread.id, title: thread.title, updatedAt: thread.updatedAt,
          content: thread.messages.slice(-12).map(item => `${item.role}: ${item.content}`).join('\n'),
        })),
      }),
    });
    if (response.ok) {
      const result = await response.json();
      const selected = candidates.find(thread => thread.id === result.selectedThreadId);
      if (selected) { selectThread(selected); return true; }
    }
  } catch (error) {
    if (error.name === 'AbortError') return false;
  } finally {
    if (state.requestController === requestController) state.requestController = null;
  }
  return resumePreviousByCharacters(command, candidates);
}

async function handleLocalCommand(text) {
  const compact = text.replace(/[，。！？,.!?\s]/g, '');
  if (/^(新话题|新会话|新对话|创建新话题|创建新会话|创建新对话|新建会话|新建对话|开始新话题|开始新会话|开始新的对话|开启新会话|换个话题|换个会话)$/.test(compact)) { newTopic(false); showToast('等待第一句话，不会创建空会话'); return true; }
  if (/^(切换到|进入|开启)?深度模式$/.test(compact)) {
    state.settings.deepMode = true; persist(); syncSettingsUI(); setStatus('idle', '后续问题将使用深度模型'); showToast('已切换到深度模式'); return true;
  }
  if (/^(切换到|进入|开启)?(快速|普通|正常)模式$/.test(compact)) {
    state.settings.deepMode = false; persist(); syncSettingsUI(); setStatus('idle', '后续问题将使用快速模型'); showToast('已切换到快速模式'); return true;
  }
  if (/(继续|恢复|回到|找到|打开).*(之前|以前|上次|对话|会话|话题)/.test(compact)) {
    if (!await resumePrevious(text)) { showToast('没有找到匹配的历史会话'); setStatus('error', '可以说出更具体的内容或时间'); }
    return true;
  }
  return false;
}

function consumeInlineModeCommand(text) {
  const prefixMatch = text.match(/^(?:(?:并且|然后|再|同时|接着)\s*)*(?:请|帮我)?(?:切换到?|进入|开启|使用|用)\s*((?:深度|快速|普通|正常|快答)模式|快问快答模式)[，,。.!！：:\s]*([\s\S]*)$/);
  const suffixMatch = prefixMatch ? null : text.match(/^([\s\S]+?)[，,。.!！：:\s]*(?:(?:然后|再|最后|接着)\s*)*(?:请|帮我)?(?:切换到?|开启|使用|用)?\s*((?:深度|快速|普通|正常|快答)模式|快问快答模式)(?:去|来)?(?:帮我)?(?:分析|回答|处理|思考|搞)(?:一下|上面的内容|前面的内容)?[。！？!?\s]*$/);
  let modeLabel = prefixMatch?.[1] || suffixMatch?.[2];
  let prompt = prefixMatch?.[2] || suffixMatch?.[1];
  if (!modeLabel) {
    const mentions = [...text.matchAll(/(?:深度|快速|普通|正常|快答)模式|快问快答模式/g)];
    const last = mentions.at(-1);
    if (last) {
      const nearby = text.slice(Math.max(0, last.index - 18), Math.min(text.length, last.index + last[0].length + 18));
      if (/(切换|进入|开启|使用|用|帮我|回答|分析|处理|思考|搞一下|搞一搞)/.test(nearby)) {
        modeLabel = last[0];
        const punctuation = /[，。！？,!?]/;
        let segmentStart = last.index;
        while (segmentStart > 0 && !punctuation.test(text[segmentStart - 1])) segmentStart -= 1;
        let segmentEnd = last.index + last[0].length;
        while (segmentEnd < text.length && !punctuation.test(text[segmentEnd])) segmentEnd += 1;
        if (segmentEnd < text.length) segmentEnd += 1;
        prompt = `${text.slice(0, segmentStart)}${text.slice(segmentEnd)}`.trim();
      }
    }
  }
  if (!modeLabel || !prompt?.trim()) return null;
  const deepMode = modeLabel.includes('深度');
  state.settings.deepMode = deepMode;
  persist(); syncSettingsUI();
  showToast(`已用${deepMode ? '深度' : '快速'}模式处理这个问题`);
  prompt = prompt.replace(/^(?:(?:然后再|然后|再|并且|接着)\s*)+/, '').trim();
  return prompt;
}

function consumeInlineNewTopicCommand(text) {
  const match = text.match(/^(?:请)?(?:(?:(?:开启|创建|新建|开始)(?:一个|个|新的)?|换(?:一个|个)?)\s*(?:新)?(?:话题|会话|对话)|(?:新话题|新会话|新对话))[，,。.!！：:\s]*([\s\S]*)$/);
  if (!match || !match[1].trim()) return null;
  newTopic(false);
  showToast('正在新话题中执行问题');
  return match[1].trim();
}

function cancelGeneration() {
  if (!state.requestController) return false;
  state.requestController.abort();
  state.requestController = null;
  $('#thinkingMessage')?.remove();
  $('#sendButton').disabled = false;
  showToast('已打断上一次生成');
  return true;
}

async function interpretCommand(text) {
  const hasKey = IS_HOSTED ? Boolean(state.settings.apiKey) : state.settings.hasApiKey;
  if (!state.backendOnline || !hasKey) return null;
  try {
    setStatus('thinking', '正在理解指令和问题…');
    const response = await fetch('/api/interpret-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(IS_HOSTED ? { 'X-API-Key': state.settings.apiKey } : {}) },
      body: JSON.stringify({ baseUrl: state.settings.baseUrl, model: state.settings.model, text }),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}

async function applyInterpretedCommand(text) {
  const command = await interpretCommand(text);
  if (!command) return null;
  if (command.newTopic) { newTopic(false); showToast('将在第一句话发送后创建新话题'); }
  if (command.mode === 'deep' || command.mode === 'fast') {
    state.settings.deepMode = command.mode === 'deep'; persist(); syncSettingsUI();
    showToast(`已切换到${command.mode === 'deep' ? '深度' : '快速'}模式`);
  }
  if (command.resumeQuery) {
    const resumed = await resumePrevious(command.resumeQuery);
    if (!resumed) showToast('没有找到匹配的历史会话');
  }
  return String(command.prompt ?? text).trim();
}

async function submitPrompt(text, inputTrace = {}) {
  text = text.trim();
  if (!text || state.status === 'thinking') return;
  const interpreted = await applyInterpretedCommand(text);
  if (interpreted != null) text = interpreted;
  else {
    text = consumeInlineNewTopicCommand(text) || text;
    text = consumeInlineModeCommand(text) || text;
  }
  if (!text) { setStatus('idle'); return; }
  if (await handleLocalCommand(text)) return;
  // 新话题只在第一条有效消息即将发送时落库；并锁定本次请求所属会话。
  const requestThread = commitPendingNewTopic();
  const requestThreadId = requestThread.id;
  addMessage('user', text, '', inputTrace, requestThreadId);
  if (!state.backendOnline) { setStatus('error', '本地服务未启动，请双击“启动 Press to Think”'); showToast('本地服务未启动'); return; }
  const hasKey = IS_HOSTED ? Boolean(state.settings.apiKey) : state.settings.hasApiKey;
  if (!hasKey) { setStatus('error', '请先在右上角设置新的 DeepSeek API Key'); openDrawer('settingsDrawer'); return; }

  setStatus('thinking'); $('#sendButton').disabled = true;
  const requestController = new AbortController(); state.requestController = requestController;
  const thinking = document.createElement('article'); thinking.className = 'message assistant'; thinking.id = 'thinkingMessage';
  thinking.innerHTML = '<div class="message-meta"><span>PRESS TO THINK</span></div><div class="thinking-row"><i></i><i></i><i></i></div>';
  $('#messages').appendChild(thinking); $('#messages').scrollTop = $('#messages').scrollHeight;
  try {
    const model = state.settings.model;
    const messages = requestThread.messages.map(item => ({ role: item.role, content: item.content }));
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(IS_HOSTED ? { 'X-API-Key': state.settings.apiKey } : {}) },
      body: JSON.stringify({ baseUrl: state.settings.baseUrl, model, mode: state.settings.deepMode ? 'deep' : 'normal', messages }),
      signal: requestController.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `请求失败（${response.status}）`);
    const answerMessage = addMessage('assistant', result.fullAnswer, '', {}, requestThreadId);
    setStatus('thinking', '完整回答已生成，正在压缩播放摘要…');
    const summaryResponse = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(IS_HOSTED ? { 'X-API-Key': state.settings.apiKey } : {}) },
      body: JSON.stringify({ baseUrl: state.settings.baseUrl, model, question: text, fullAnswer: result.fullAnswer }),
      signal: requestController.signal,
    });
    const summaryResult = await summaryResponse.json().catch(() => ({}));
    if (!summaryResponse.ok) throw new Error(summaryResult.error || '播放摘要生成失败');
    answerMessage.spoken = summaryResult.spokenAnswer;
    answerMessage.summary = summaryResult.summary || summaryResult.spokenAnswer;
    answerMessage.suggestion = summaryResult.suggestion || '';
    answerMessage.hypothesis = summaryResult.hypothesis || '';
    answerMessage.followUp = summaryResult.followUp || '继续深入分析这个问题';
    requestThread.updatedAt = Date.now();
    persist();
    if (!state.pendingNewTopic && state.currentThreadId === requestThreadId) renderThread();
    else renderThreadList();
    setStatus('ready'); playAnswerReadyCue();
  } catch (error) {
    if (error.name === 'AbortError') { $('#thinkingMessage')?.remove(); return; }
    const message = error instanceof TypeError ? '本地服务连接中断，请重新启动 Press to Think' : error.message;
    $('#thinkingMessage')?.remove(); setStatus('error', message); showToast(message);
  } finally {
    if (state.requestController === requestController) state.requestController = null;
    $('#sendButton').disabled = false;
  }
}

function speechRecognitionConstructor() { return window.SpeechRecognition || window.webkitSpeechRecognition; }
function playListeningCue() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 660; gain.gain.value = 0.025;
    oscillator.connect(gain); gain.connect(context.destination);
    oscillator.start(); oscillator.stop(context.currentTime + 0.07);
    oscillator.addEventListener('ended', () => context.close());
  } catch {}
}
function beginListening() {
  if (state.status === 'thinking') cancelGeneration();
  stopSpeaking();
  if (window.PTTAndroid) {
    if (!state.settings.tencentAsr || !state.settings.hasTencentAsr) {
      setStatus('error', '安卓版语音输入需要先开启腾讯云 ASR');
      showToast('请在设置中开启腾讯云 ASR'); return false;
    }
    state.finalTranscript = ''; state.interimTranscript = ''; state.recognitionReady = true;
    state.captureStartedAt = Date.now();
    try { window.PTTAndroid.startCapture(); setStatus('listening', '正在通过手机麦克风收音…'); $('#liveTranscript').textContent = '正在收音'; return true; }
    catch { setStatus('error', '无法启动手机麦克风'); return false; }
  }
  const Recognition = speechRecognitionConstructor();
  if (!Recognition) { setStatus('error', '当前浏览器不支持语音识别，请用下方文字框测试'); showToast('请使用 Chrome，或先用文字输入'); return false; }
  state.finalTranscript = ''; state.interimTranscript = ''; state.ignoreRecognitionEnd = false; state.recognitionReady = false;
  startAudioCapture();
  clearTimeout(state.finishTimer);
  const recognition = new Recognition(); state.recognition = recognition;
  recognition.lang = 'zh-CN'; recognition.interimResults = true; recognition.continuous = true; recognition.maxAlternatives = 3;
  recognition.onstart = () => {
    state.recognitionReady = true;
    setStatus('listening', '听到提示音后开始说，松开发送');
    $('#liveTranscript').textContent = '可以说了';
    playListeningCue();
  };
  recognition.onresult = event => {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const text = event.results[index][0].transcript;
      if (event.results[index].isFinal) state.finalTranscript += text; else interim += text;
    }
    state.interimTranscript = interim;
    $('#liveTranscript').textContent = state.finalTranscript + interim || '正在打开麦克风…';
  };
  recognition.onerror = event => {
    const labels = { 'not-allowed': '麦克风权限被拒绝，请在浏览器地址栏允许麦克风', 'service-not-allowed': '当前浏览器禁止使用语音识别服务，请改用 Chrome 打开', 'audio-capture': '没有检测到可用麦克风，请检查系统麦克风权限', 'no-speech': '没有听到声音，请靠近一点再试', network: '语音识别服务暂时无法连接，请检查网络后重试' };
    if (event.error !== 'aborted') { setStatus('error', labels[event.error] || `录音失败：${event.error}`); showToast(labels[event.error] || '录音失败'); }
  };
  recognition.onend = () => {
    if (state.isHolding && !state.ignoreRecognitionEnd) {
      try { recognition.start(); } catch {}
    }
  };
  try { recognition.start(); setStatus('listening', '正在启动麦克风，请稍候…'); $('#liveTranscript').textContent = '正在打开麦克风…'; return true; }
  catch { setStatus('error', '无法启动麦克风，请刷新后重试'); return false; }
}

async function startAudioCapture() {
  state.audioChunks = []; state.captureStartedAt = Date.now();
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!state.isHolding) { stream.getTracks().forEach(track => track.stop()); return; }
    const recorder = new MediaRecorder(stream); state.mediaStream = stream; state.mediaRecorder = recorder;
    recorder.ondataavailable = event => { if (event.data.size) state.audioChunks.push(event.data); };
    recorder.start(250);
  } catch { /* 浏览器语音识别仍可继续；录音保存是增强能力。 */ }
}

function stopAudioCapture() {
  return new Promise(resolve => {
    const recorder = state.mediaRecorder; const stream = state.mediaStream;
    if (!recorder || recorder.state === 'inactive') { stream?.getTracks().forEach(track => track.stop()); resolve(null); return; }
    recorder.addEventListener('stop', () => {
      const blob = new Blob(state.audioChunks, { type: recorder.mimeType || 'audio/webm' });
      stream?.getTracks().forEach(track => track.stop()); state.mediaRecorder = null; state.mediaStream = null; state.audioChunks = [];
      resolve(blob);
    }, { once: true });
    recorder.stop();
  });
}

async function blobToPcm16(blob) {
  if (!blob?.size) return null;
  const context = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const length = Math.ceil(decoded.duration * 16000);
    const offline = new OfflineAudioContext(1, length, 16000);
    const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
    const rendered = await offline.startRendering(); const samples = rendered.getChannelData(0);
    const pcm = new ArrayBuffer(samples.length * 2); const view = new DataView(pcm);
    for (let i = 0; i < samples.length; i += 1) {
      const value = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    }
    return pcm;
  } finally { context.close(); }
}

async function transcribeWithTencent(audioBlob) {
  if (!state.settings.tencentAsr || !state.settings.hasTencentAsr || !audioBlob?.size) return '';
  setStatus('listening', '正在用腾讯云大模型识别语音…');
  const pcm = await blobToPcm16(audioBlob);
  if (!pcm) return '';
  const bytes = new Uint8Array(pcm); let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  const response = await fetch('/api/tencent-transcript', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: btoa(binary) }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || '腾讯云识别失败');
  return String(result.transcript || '').trim();
}

function finishListening(submit = true) {
  if (window.PTTAndroid) {
    if (!submit) { window.PTTAndroid.cancelCapture(); setStatus('idle'); return; }
    setStatus('listening', '正在识别手机录音…');
    const timeout = setTimeout(() => { window.pttAndroidAudioReady?.('', '录音超时，请重试'); }, 10_000);
    new Promise(resolve => { window.pttAndroidAudioReady = (audio, error) => resolve({ audio, error }); })
      .then(async ({ audio, error }) => {
        clearTimeout(timeout); window.pttAndroidAudioReady = null;
        if (error || !audio) throw new Error(error || '没有录到声音');
        const response = await fetch('/api/tencent-transcript', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio }) });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.transcript) throw new Error(result.error || '语音识别失败');
        const corrected = await correctTranscript(result.transcript);
        $('#liveTranscript').textContent = corrected;
        submitPrompt(corrected, { originalTranscript: result.transcript, correctedTranscript: corrected, finalPrompt: corrected, audioDurationMs: Date.now() - state.captureStartedAt });
      }).catch(error => { setStatus('error', error.message); showToast(error.message); });
    window.PTTAndroid.stopCapture(); return;
  }
  state.ignoreRecognitionEnd = true;
  try { state.recognition?.stop(); } catch {}
  state.recognition = null;
  if (!submit) { stopAudioCapture(); $('#liveTranscript').textContent = '等待输入'; setStatus('idle'); return; }
  // stop() 后浏览器仍可能补发最后一个 result。留出极短缓冲，避免吞掉句尾。
  setStatus('listening', '正在确认最后一句…');
  clearTimeout(state.finishTimer);
  state.finishTimer = setTimeout(async () => {
    let transcript = (state.finalTranscript + state.interimTranscript).trim();
    const audioBlob = await stopAudioCapture();
    if (state.settings.tencentAsr && state.settings.hasTencentAsr) {
      try { transcript = await transcribeWithTencent(audioBlob) || transcript; }
      catch (error) { showToast(`${error.message}，已回退浏览器识别`); }
    }
    if (!transcript) { $('#liveTranscript').textContent = '没有识别到内容'; setStatus('error', state.recognitionReady ? '请靠近一点，并按住按钮更久再说' : '麦克风刚刚才启动，请听到提示音后再说'); return; }
    const corrected = await correctTranscript(transcript);
    let audioId = '';
    try { audioId = await saveAudio(audioBlob); } catch { showToast('文字已保留，但原始录音保存失败'); }
    $('#liveTranscript').textContent = corrected;
    submitPrompt(corrected, { originalTranscript: transcript, correctedTranscript: corrected, finalPrompt: corrected, audioId, audioDurationMs: Date.now() - state.captureStartedAt });
  }, 480);
}

async function correctTranscript(transcript) {
  if (!state.settings.hasApiKey) return transcript;
  setStatus('listening', '正在理解并校正语音…');
  try {
    const context = currentThread().messages.slice(-8).map(item => `${item.role}: ${item.content}`).join('\n');
    const response = await fetch('/api/transcript', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: state.settings.baseUrl, model: state.settings.model, transcript, context }),
    });
    if (!response.ok) return transcript;
    const result = await response.json();
    return String(result.correctedText || transcript).trim();
  } catch { return transcript; }
}

function handlePressStart(event) {
  if (event?.button != null && event.button !== 0) return;
  if (state.isHolding) return;
  event?.preventDefault();
  state.isHolding = true; state.pressStarted = performance.now();
  state.listeningStarted = false;
  try { event?.currentTarget?.setPointerCapture?.(event.pointerId); } catch {}
  // 先等待确认这是长按。短按/双击绝不打开麦克风，避免把语音播放重新收进去。
  clearTimeout(state.pressTimer);
  state.pressTimer = setTimeout(() => {
    if (!state.isHolding) return;
    state.listeningStarted = beginListening();
  }, 260);
}

function handlePressEnd(event) {
  if (!state.isHolding) return;
  event?.preventDefault(); state.isHolding = false;
  clearTimeout(state.pressTimer); state.pressTimer = null;
  const duration = performance.now() - state.pressStarted;
  if (!state.listeningStarted || duration < 260) {
    const now = Date.now();
    if (state.status === 'thinking' || state.requestController) {
      state.lastTapAt = now;
      setStatus('thinking', '回答仍在生成，完成后会提醒你');
      showToast('回答仍在生成中');
    } else if (now - state.lastTapAt < 420) { state.lastTapAt = 0; playLatestAnswer(); }
    else { state.lastTapAt = now; setStatus(currentThread().messages.some(m => m.spoken) ? 'ready' : 'idle', '再次轻点播放最近回答；长按则说话'); }
  } else finishListening(true);
  state.listeningStarted = false;
}

function latestSpokenAnswer() {
  const answer = [...currentThread().messages].reverse().find(item => item.role === 'assistant' && (item.summary || item.spoken));
  return answer?.summary || answer?.spoken || '';
}
function loadVoices() {
  state.voices = speechSynthesis.getVoices();
  const select = $('#voiceSelect'); const selected = state.settings.voiceURI;
  select.innerHTML = '<option value="">系统默认声音</option>' + state.voices
    .filter(voice => /^zh|Chinese|Ting|Meijia|Sinji|Yu-shu/i.test(`${voice.lang} ${voice.name}`))
    .map(voice => `<option value="${escapeHtml(voice.voiceURI)}">${escapeHtml(voice.name)} · ${escapeHtml(voice.lang)}</option>`).join('');
  select.value = selected;
}
function playWithSystemVoice(text) {
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'zh-CN'; utterance.rate = .98; utterance.pitch = 1.02;
  utterance.voice = state.voices.find(voice => voice.voiceURI === state.settings.voiceURI) || null;
  utterance.onstart = () => setStatus('speaking');
  utterance.onend = () => { $('#liveTranscript').textContent = '等待输入'; setStatus('ready'); };
  utterance.onerror = () => { $('#liveTranscript').textContent = '等待输入'; setStatus('ready', '播放被中止，可以再次双击'); };
  speechSynthesis.speak(utterance);
}
async function playLatestAnswer() {
  const text = latestSpokenAnswer();
  if (!text) { showToast('当前会话还没有可播放的回答'); setStatus('idle'); return; }
  stopSpeaking();
  // 播放与收音严格互斥，播放前彻底关闭可能残留的识别器和录音流。
  state.ignoreRecognitionEnd = true;
  try { state.recognition?.abort(); } catch {}
  state.recognition = null;
  stopAudioCapture();
  $('#liveTranscript').textContent = '正在播放口语摘要';
  if (state.settings.tencentTts && state.settings.hasTencentTts) {
    try {
      setStatus('speaking', '正在准备腾讯精品语音…');
      const response = await fetch('/api/tencent-tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voiceType: state.settings.tencentVoiceType, speed: 0 }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.audio) throw new Error(result.error || '精品语音生成失败');
      const bytes = Uint8Array.from(atob(result.audio), character => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType || 'audio/mpeg' }));
      const audio = new Audio(url); state.activeAudio = audio; state.activeAudioUrl = url;
      audio.onplay = () => setStatus('speaking', '腾讯精品语音正在播放');
      audio.onended = () => { stopSpeaking(); $('#liveTranscript').textContent = '等待输入'; setStatus('ready'); };
      audio.onerror = () => { stopSpeaking(); showToast('腾讯精品语音播放失败，已改用系统声音'); playWithSystemVoice(text); };
      await audio.play(); return;
    } catch (error) { stopSpeaking(); showToast(`${error.message}，已改用系统声音`); }
  }
  playWithSystemVoice(text);
}
function stopSpeaking() {
  if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
  if (state.activeAudio) { state.activeAudio.onended = null; state.activeAudio.onerror = null; state.activeAudio.pause(); state.activeAudio.currentTime = 0; state.activeAudio = null; }
  if (state.activeAudioUrl) { URL.revokeObjectURL(state.activeAudioUrl); state.activeAudioUrl = ''; }
}

function openDrawer(id) { closeDrawers(); $(`#${id}`).classList.add('open'); $(`#${id}`).setAttribute('aria-hidden', 'false'); $('#backdrop').classList.add('show'); }
function closeDrawers() {
  document.querySelectorAll('.drawer.open').forEach(drawer => { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); });
  $('#historyDrawer').setAttribute('aria-hidden', window.matchMedia('(max-width: 760px)').matches ? 'true' : 'false');
  $('#backdrop').classList.remove('show');
}
function syncSettingsUI() {
  $('#apiKeyInput').value = '';
  const configured = IS_HOSTED ? Boolean(state.settings.apiKey) : state.settings.hasApiKey;
  $('#apiKeyInput').placeholder = configured ? `已保存 ${state.settings.keyHint || 'API Key'}；留空则不更换` : 'sk-...';
  $('#baseUrlInput').value = state.settings.baseUrl;
  $('#modelInput').value = state.settings.model;
  $('#deepModeInput').checked = state.settings.deepMode; $('#voiceSelect').value = state.settings.voiceURI;
  $('#tencentAppIdInput').value = state.settings.tencentAppId || '';
  $('#tencentSecretIdInput').value = ''; $('#tencentSecretKeyInput').value = '';
  $('#tencentSecretIdInput').placeholder = state.settings.hasTencentAsr ? `已保存 ${state.settings.tencentKeyHint || 'SecretId'}；留空不更换` : 'SecretId';
  $('#tencentSecretKeyInput').placeholder = state.settings.hasTencentAsr ? '已安全保存在本机；留空不更换' : 'SecretKey';
  $('#tencentAsrInput').checked = Boolean(state.settings.tencentAsr);
  $('#tencentTtsInput').checked = Boolean(state.settings.tencentTts);
  $('#tencentVoiceTypeInput').value = String(state.settings.tencentVoiceType || 101004);
  const credentialStatus = $('#tencentCredentialStatus');
  const hasTencentCredentials = Boolean(state.settings.hasTencentTts || state.settings.hasTencentAsr);
  credentialStatus.textContent = hasTencentCredentials
    ? `✓ 腾讯云密钥已保存在本机${state.settings.tencentKeyHint ? `（${state.settings.tencentKeyHint}）` : ''}`
    : '腾讯云密钥尚未保存';
  credentialStatus.classList.toggle('saved', hasTencentCredentials);
  $('#testTencentVoiceButton').disabled = !hasTencentCredentials;
  const modelLabel = state.settings.model === 'deepseek-v4-pro' ? 'V4 Pro' : state.settings.model;
  $('#modeLabel').textContent = `${state.settings.deepMode ? '深度模式' : '快速模式'} · ${modelLabel}`;
}

async function checkBackend(showFailure = true) {
  const dot = document.querySelector('.connection-dot');
  try {
    const health = await fetch('/api/health', { cache: 'no-store' });
    if (!health.ok) throw new Error('offline');
    state.backendOnline = true; dot.classList.remove('offline');
    const settingsResponse = await fetch('/api/settings', { cache: 'no-store' });
    if (settingsResponse.ok) state.settings = { ...state.settings, ...await settingsResponse.json() };
    const micText = window.PTTAndroid || speechRecognitionConstructor() ? '麦克风可用' : '语音请使用 Chrome';
    $('#connectionLabel').textContent = `本地服务已连接 · ${micText}`;
    // 后台轮询只更新连接状态；设置抽屉打开时绝不能重绘正在输入的表单。
    if (!$('#settingsDrawer').classList.contains('open')) syncSettingsUI();
    persist();
    return true;
  } catch {
    state.backendOnline = false; dot.classList.add('offline');
    $('#connectionLabel').textContent = '本地服务未启动';
    if (showFailure && state.status !== 'listening') setStatus('error', '请双击“启动 Press to Think.command”');
    return false;
  }
}

$('#pttButton').addEventListener('pointerdown', handlePressStart);
$('#pttButton').addEventListener('pointerup', handlePressEnd);
$('#pttButton').addEventListener('pointercancel', handlePressEnd);
$('#pttButton').addEventListener('contextmenu', event => event.preventDefault());
document.addEventListener('keydown', event => {
  if (event.code !== 'Space' || event.repeat || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  handlePressStart(event);
});
document.addEventListener('keyup', event => { if (event.code === 'Space' && state.isHolding) handlePressEnd(event); });
document.addEventListener('pointerdown', prepareAnswerReadyCue, { passive: true });
document.addEventListener('keydown', prepareAnswerReadyCue);
$('#textForm').addEventListener('submit', event => { event.preventDefault(); prepareAnswerReadyCue(); const input = $('#textInput'); const value = input.value; input.value = ''; submitPrompt(value); });
$('#textInput').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#textForm').requestSubmit(); } });
$('#newTopicButton').addEventListener('click', () => newTopic());
$('#drawerNewTopic').addEventListener('click', () => { closeDrawers(); newTopic(); });
$('#historyButton').addEventListener('click', () => openDrawer('historyDrawer'));
window.matchMedia('(max-width: 760px)').addEventListener('change', () => {
  closeDrawers();
});
$('#settingsButton').addEventListener('click', () => {
  if ($('#settingsDrawer').classList.contains('open')) return;
  syncSettingsUI(); openDrawer('settingsDrawer');
});
$('#backdrop').addEventListener('click', closeDrawers);
document.querySelectorAll('.drawer-close').forEach(button => button.addEventListener('click', closeDrawers));
function openRecordSheet() {
  closeDrawers();
  $('#recordSheet').classList.add('open');
  $('#recordSheet').setAttribute('aria-hidden', 'false');
  $('#backdrop').classList.add('show');
}
function closeRecordSheet() {
  $('#recordSheet').classList.remove('open');
  $('#recordSheet').setAttribute('aria-hidden', 'true');
  $('#backdrop').classList.remove('show');
}
$('#recordButton').addEventListener('click', openRecordSheet);
$('#recordingsNav').addEventListener('click', openRecordSheet);
$('#tasksNav').addEventListener('click', () => showToast('Agent 任务中心将在下一版接入'));
$('#closeRecordSheet').addEventListener('click', closeRecordSheet);
$('#backdrop').addEventListener('click', closeRecordSheet);
$('#testTencentVoiceButton').addEventListener('click', async () => {
  const button = $('#testTencentVoiceButton'); button.disabled = true; button.textContent = '正在生成试听…';
  try {
    stopSpeaking();
    const response = await fetch('/api/tencent-tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '你好，我是 Press to Think。你的想法已经整理好了。', voiceType: Number($('#tencentVoiceTypeInput').value), speed: 0 }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.audio) throw new Error(result.error || '试听生成失败');
    const bytes = Uint8Array.from(atob(result.audio), character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType || 'audio/mpeg' }));
    const audio = new Audio(url); state.activeAudio = audio; state.activeAudioUrl = url;
    audio.onended = () => { stopSpeaking(); showToast('腾讯精品语音试听完成'); };
    audio.onerror = () => { stopSpeaking(); showToast('试听音频无法播放'); };
    await audio.play();
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; button.textContent = '试听当前腾讯音色'; }
});
$('#settingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const saveButton = event.submitter || $('#settingsForm .save-button');
  saveButton.disabled = true; saveButton.textContent = '正在保存…';
  try {
    if (!state.backendOnline && !await checkBackend(false)) throw new Error('本地服务未启动');
    const localPreferences = { deepMode: $('#deepModeInput').checked, voiceURI: $('#voiceSelect').value, tencentAsr: $('#tencentAsrInput').checked, tencentTts: $('#tencentTtsInput').checked, tencentVoiceType: Number($('#tencentVoiceTypeInput').value) };
    if (IS_HOSTED) {
      const enteredKey = $('#apiKeyInput').value.trim();
      state.settings = {
        ...state.settings, ...localPreferences,
        apiKey: enteredKey || state.settings.apiKey,
        hasApiKey: Boolean(enteredKey || state.settings.apiKey),
        keyHint: enteredKey ? `${enteredKey.slice(0, 3)}••••${enteredKey.slice(-4)}` : state.settings.keyHint,
        baseUrl: $('#baseUrlInput').value.trim() || defaultSettings.baseUrl,
        model: $('#modelInput').value.trim() || defaultSettings.model,
      };
    }
    const response = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: IS_HOSTED ? '' : $('#apiKeyInput').value.trim(), baseUrl: $('#baseUrlInput').value.trim(), model: $('#modelInput').value.trim(),
        tencentAppId: $('#tencentAppIdInput').value.trim(), tencentSecretId: $('#tencentSecretIdInput').value.trim(),
        tencentSecretKey: $('#tencentSecretKeyInput').value.trim(), tencentAsr: $('#tencentAsrInput').checked,
        tencentTts: $('#tencentTtsInput').checked, tencentVoiceType: Number($('#tencentVoiceTypeInput').value),
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '设置保存失败');
    state.settings = { ...state.settings, ...localPreferences, ...result };
    const verifyResponse = await fetch('/api/settings', { cache: 'no-store' });
    const verified = verifyResponse.ok ? await verifyResponse.json() : result;
    state.settings = { ...state.settings, ...verified };
    if (($('#tencentAppIdInput').value.trim() || $('#tencentSecretIdInput').value.trim() || $('#tencentSecretKeyInput').value.trim()) && !verified.hasTencentTts) throw new Error('腾讯云配置未能保存，请检查三个字段是否完整');
    persist(); syncSettingsUI(); closeDrawers(); setStatus('idle'); showToast('设置已保存并校验成功');
  } catch (error) { showToast(`保存失败：${error.message}；已保留当前输入`); setStatus('error', '设置未保存，请检查提示并重试'); }
  finally { saveButton.disabled = false; saveButton.textContent = '保存并确认'; }
});

speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
closeDrawers(); loadVoices(); syncSettingsUI(); renderThread(); setStatus('idle'); persist();
checkBackend().then(online => {
  const hasKey = IS_HOSTED ? Boolean(state.settings.apiKey) : state.settings.hasApiKey;
  if (online && !hasKey) setTimeout(() => showToast('先在右上角设置 DeepSeek API Key'), 500);
});
setInterval(() => checkBackend(false), 12_000);
