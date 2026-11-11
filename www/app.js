(() => {
  'use strict';
  const L = window.ChatLogic;
  const $ = (s, r = document) => r.querySelector(s);

  /* ---------- 작은 도우미 ---------- */
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'innerHTML') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    kids.flat().forEach((c) => c != null && e.append(c.nodeType ? c : document.createTextNode(c)));
    return e;
  }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function inline(p) {
    return L.esc(p).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
  }
  function fmt(s) {
    return String(s).split(/```/).map((p, i) => (i % 2 ? '<pre><code>' + L.esc(p.replace(/^\w*\n/, '')) + '</code></pre>' : inline(p))).join('');
  }

  /* ---------- 기본 AI 4명 ---------- */
  const DEFAULT_AIS = [
    { id: 'nvidia', label: 'NVIDIA', kind: 'cloud', base: 'https://integrate.api.nvidia.com/v1', model: 'deepseek-ai/deepseek-v4-flash', color: '#76b900' },
    { id: 'groq', label: 'Groq', kind: 'cloud', base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', color: '#ff7a59' },
    { id: 'openrouter', label: 'OpenRouter', kind: 'cloud', base: 'https://openrouter.ai/api/v1', model: 'openrouter/free', color: '#8f7cff' },
    { id: 'local', label: '로컬', kind: 'local', base: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:3b', color: '#f0b429' },
  ].map((a) => Object.assign({ enabled: true, nickname: '', aliases: [], key: '' }, a));
  const SAVED_KEYS = ['enabled', 'nickname', 'aliases', 'key', 'model', 'base'];

  const state = { ais: [], messages: [], memory: [], settings: { contextN: 12, search: true }, status: {} };
  const STORE = 'aigc.v1';

  function load() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE)); } catch (e) { /* 저장소 없음 */ }
    saved = saved || {};
    state.ais = DEFAULT_AIS.map((d) => {
      const s = (saved.ais || []).find((a) => a.id === d.id) || {};
      const o = Object.assign({}, d);
      SAVED_KEYS.forEach((k) => { if (s[k] !== undefined) o[k] = s[k]; });
      return o;
    });
    state.messages = (saved.messages || []).filter((m) => !m.streaming);
    state.memory = saved.memory || [];
    Object.assign(state.settings, saved.settings || {});
  }
  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        ais: state.ais.map((a) => { const o = { id: a.id }; SAVED_KEYS.forEach((k) => { o[k] = a[k]; }); return o; }),
        settings: state.settings, memory: state.memory,
        messages: state.messages.filter((m) => !m.streaming).slice(-300),
      }));
    } catch (e) { /* 저장 실패해도 계속 */ }
  }

  const aiById = (id) => state.ais.find((a) => a.id === id);
  const nameOf = (id) => { const a = aiById(id); return a ? L.displayName(a) : id; };
  const online = () => navigator.onLine !== false;

  /* ---------- 네트워크 ---------- */
  const transport = {};
  const nativeHttp = () => (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) || null;
  const raceAbort = (p, signal) => new Promise((res, rej) => {
    if (signal) {
      if (signal.aborted) return rej(Object.assign(new Error('stopped'), { code: 'stopped' }));
      signal.addEventListener('abort', () => rej(signal.reason && signal.reason.code ? signal.reason : Object.assign(new Error('stopped'), { code: 'stopped' })));
    }
    p.then(res, rej);
  });
  const hdr = (r, k) => { const x = r.headers || {}; return x[k] || x[k.toLowerCase()] || x[k.replace(/(^|-)(\w)/g, (m, a, b) => a + b.toUpperCase())]; };

  async function webStream(url, headers, body, o) {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: o.signal });
    if (!res.ok) throw new L.HttpError(res.status, await res.text().catch(() => ''), res.headers.get('retry-after'));
    if (!res.body || !res.body.getReader) {
      const j = await res.json();
      const t = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
      o.onDelta && o.onDelta(t);
      return t;
    }
    const rd = res.body.getReader(), dec = new TextDecoder();
    let buf = '', out = '';
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (!d || d === '[DONE]') continue;
        let j; try { j = JSON.parse(d); } catch (e) { continue; }
        if (j.error) throw new L.HttpError(j.error.code || 500, JSON.stringify(j.error));
        const t = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (t) { out += t; o.onDelta && o.onDelta(out); }
      }
    }
    return out;
  }
  async function nativeChat(url, headers, body, o) {
    const P = nativeHttp();
    if (!P) throw new TypeError('network');
    const r = await raceAbort(P.request({ url, method: 'POST', headers, data: body, readTimeout: 120000, connectTimeout: 20000 }), o.signal);
    if (r.status >= 400) throw new L.HttpError(r.status, typeof r.data === 'string' ? r.data : JSON.stringify(r.data), hdr(r, 'retry-after'));
    let d = r.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { /* 문자열 그대로 */ } }
    const t = (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
    o.onDelta && o.onDelta(t);
    return t;
  }
  /* 먼저 일반 fetch(스트리밍)로 시도하고, 브라우저 제한(CORS/혼합콘텐츠)에 막히면 안드로이드 네이티브 HTTP로 전환 */
  async function callChat(ai, messages, o = {}) {
    const url = ai.base.replace(/\/+$/, '') + '/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (ai.key) headers.Authorization = 'Bearer ' + ai.key;
    const body = Object.assign({ model: ai.model, messages }, o.extraBody || {});
    if (transport[ai.id] !== 'native') {
      try { return await webStream(url, headers, Object.assign({ stream: true }, body), o); }
      catch (e) { if (e instanceof TypeError && nativeHttp()) transport[ai.id] = 'native'; else throw e; }
    }
    return nativeChat(url, headers, body, o);
  }
  async function httpGetText(url, headers) {
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) throw new L.HttpError(r.status, '');
      return await r.text();
    } catch (e) {
      if (e instanceof TypeError && nativeHttp()) {
        const r = await nativeHttp().request({ url, method: 'GET', headers: headers || {}, responseType: 'text' });
        if (r.status >= 400) throw new L.HttpError(r.status, '');
        return typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      }
      throw e;
    }
  }
  async function fetchModels(ai) {
    const headers = {};
    if (ai.key) headers.Authorization = 'Bearer ' + ai.key;
    const t = await httpGetText(ai.base.replace(/\/+$/, '') + '/models', headers);
    const j = JSON.parse(t);
    return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
  }
  async function webSearch(q) {
    try {
      const html = await httpGetText('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {});
      const r = L.parseDdg(html);
      if (r.length) return r.slice(0, 5);
    } catch (e) { /* 위키로 */ }
    try {
      const t = await httpGetText('https://ko.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent(q) + '&format=json&utf8=1&srlimit=4&origin=*');
      return L.parseWiki(JSON.parse(t));
    } catch (e) { return []; }
  }

  /* ---------- 상태 ---------- */
  function setStatus(id, st, extra) {
    state.status[id] = Object.assign({ state: st, since: Date.now() }, extra || {});
    renderStatus(); renderChips(); updateStop();
  }
  function renderStatus() {
    const box = $('#status'); box.innerHTML = '';
    state.ais.filter((a) => a.enabled).forEach((a) => {
      const s = state.status[a.id] || { state: 'idle' };
      const act = L.ACTIVE.includes(s.state);
      const secs = s.ms != null ? (s.ms / 1000).toFixed(1) : ((Date.now() - s.since) / 1000).toFixed(0);
      let label = s.text || L.STATE_LABEL[s.state];
      if (act || s.state === 'done') label += ' · ' + secs + '초';
      const row = h('div', { class: 'srow ' + (act ? 'active ' : '') + s.state, style: '--c:' + a.color },
        h('i', { class: 'dot' }),
        h('span', { class: 'nm' }, nameOf(a.id), h('small', { text: a.nickname ? L.shortModel(a.model) : a.label })),
        h('span', { class: 'st', text: label }),
        s.state === 'error' || s.state === 'stopped' ? h('button', { class: 'retry', type: 'button', text: '다시', onclick: () => retry(a.id) }) : h('span'));
      box.append(row);
      if (s.hint) box.append(h('div', { class: 'shint', text: '👉 ' + s.hint }));
    });
    renderTip();
  }
  function renderTip() {
    const t = $('#tip');
    const cloud = state.ais.filter((a) => a.enabled && a.kind === 'cloud');
    let msg = '';
    if (!online()) msg = '오프라인이에요. 로컬 AI만 답할 수 있어요 (아는 것과 기억만으로).';
    else if (cloud.length && cloud.every((a) => !a.key)) msg = '⚙ 설정에서 NVIDIA · Groq · OpenRouter 키를 입력하면 AI들이 답하기 시작해요.';
    t.textContent = msg; t.hidden = !msg;
    const net = $('#net'); net.textContent = online() ? '온라인' : '오프라인'; net.classList.toggle('off', !online());
  }
  function updateStop() { $('#btnStop').hidden = !state.ais.some((a) => L.ACTIVE.includes((state.status[a.id] || {}).state) && ctrls.has(a.id)); }
  setInterval(() => { if (state.ais.some((a) => L.ACTIVE.includes((state.status[a.id] || {}).state))) renderStatus(); }, 1000);

  /* ---------- 메시지 그리기 ---------- */
  const els = new Map();
  const nearBottom = () => { const m = $('#list'); return m.scrollHeight - m.scrollTop - m.clientHeight < 120; };
  const toBottom = () => { const m = $('#list'); m.scrollTop = m.scrollHeight; };
  function renderMsg(m) {
    const stick = nearBottom();
    let e = els.get(m.id);
    if (!e) { e = h('div'); els.set(m.id, e); $('#list').append(e); $('.empty') && $('.empty').remove(); }
    e.className = 'msg ' + (m.note ? 'note' : m.role) + (m.error ? ' err' : '');
    e.innerHTML = '';
    if (m.note) { e.textContent = m.text; }
    else if (m.role === 'user') {
      if (m.to && m.to.length) e.append(h('div', { class: 'to', text: '→ ' + m.to.map(nameOf).join(', ') }));
      e.append(h('div', { class: 'body', innerHTML: fmt(m.text) }));
    } else {
      const a = aiById(m.authorId) || { color: '#888', model: '' };
      e.style.setProperty('--c', a.color);
      e.append(h('div', { class: 'who' }, h('i', { style: 'background:' + a.color }), nameOf(m.authorId), nameOf(m.authorId) !== L.shortModel(a.model) ? h('small', { text: L.shortModel(a.model) }) : null));
      const b = h('div', { class: 'body' + (m.streaming ? ' cursor' : '') });
      b.innerHTML = fmt(L.stripThink(m.text) || (m.streaming ? '' : '(빈 답)'));
      e.append(b);
      if (m.sources && m.sources.length) e.append(h('div', { class: 'src', text: '검색 출처: ' + m.sources.map((s, i) => `[${i + 1}] ${L.domainOf(s.url) || s.title}`).join('  ') }));
      if (!m.streaming && m.text) {
        e.append(h('div', { class: 'acts' },
          h('button', { type: 'button', text: '📌 기억', onclick: () => remember(`${nameOf(m.authorId)}의 말: ${L.stripThink(m.text).slice(0, 200)}`) })));
      }
    }
    if (stick) toBottom();
  }
  let rafPending = new Set();
  function scheduleRender(m) {
    if (rafPending.has(m.id)) return;
    rafPending.add(m.id);
    requestAnimationFrame(() => { rafPending.delete(m.id); renderMsg(m); });
  }
  function note(text) { const m = { id: uid(), role: 'note', note: true, text, ts: Date.now() }; state.messages.push(m); renderMsg(m); save(); }
  function renderAll() {
    const list = $('#list'); list.innerHTML = ''; els.clear();
    if (!state.messages.length) {
      list.append(h('div', { class: 'empty', innerHTML: '<p><b>AI 단체방</b></p><p>그냥 말하면 모두 답해요.<br>"<b>딥이야</b> 이거 뭐야?" 처럼 이름을 부르면 그 AI만 답해요.</p><p>"<b>기억해: …</b>"라고 하면 모두가 기억해요.</p>' }));
    }
    state.messages.forEach(renderMsg); toBottom();
  }
  function renderChips() {
    const c = $('#chips'); c.innerHTML = '';
    state.ais.filter((a) => a.enabled).forEach((a) => c.append(h('button', { type: 'button', style: '--c:' + a.color, text: '@' + nameOf(a.id), onclick: () => insertMention(nameOf(a.id)) })));
  }
  function insertMention(name) {
    const i = $('#input'); i.value = (i.value ? i.value.replace(/\s*$/, ' ') : '') + '@' + name + ' '; i.focus(); autosize();
  }

  /* ---------- 기억(실시간 학습) ---------- */
  function remember(text) {
    state.memory.push({ id: uid(), text, ts: Date.now() });
    if (state.memory.length > 200) state.memory.shift();
    save(); note('📌 기억했어요: ' + text);
  }
  function handleCommand(text) {
    const c = L.parseCommand(text);
    if (!c) return false;
    if (c.type === 'remember') remember(c.arg);
    else if (c.type === 'forget') {
      const before = state.memory.length;
      state.memory = state.memory.filter((m) => !m.text.includes(c.arg));
      save(); note(before === state.memory.length ? '지울 기억이 없어요: ' + c.arg : `🗑 ${before - state.memory.length}개 잊었어요`);
    } else note(state.memory.length ? '기억 목록\n' + state.memory.map((m, i) => `${i + 1}. ${m.text}`).join('\n') : '아직 기억한 게 없어요.');
    return true;
  }

  /* ---------- AI에게 묻기 ---------- */
  const ctrls = new Map();
  const lastUserFor = {};
  const MODEL_PREF = [/deepseek.*(v4|v3)/i, /llama-3\.3-70b/i, /qwen.*(235|72|32)/i];

  async function askAI(ai, userMsg, tried = {}) {
    const id = ai.id, t0 = Date.now();
    lastUserFor[id] = userMsg.id;
    setStatus(id, 'thinking');
    const ctrl = new AbortController();
    ctrls.set(id, ctrl);
    let msg = null, got = false;
    const slow = setTimeout(() => { if (!got) setStatus(id, 'slow'); }, 8000);
    const hard = setTimeout(() => ctrl.abort(Object.assign(new Error('timeout'), { code: 'timeout' })), 120000);
    try {
      if (ai.kind !== 'local' && !ai.key) throw { code: 'nokey' };
      if (ai.kind !== 'local' && !online()) throw { code: 'offline' };
      let extra = '', sources = null;
      if (ai.kind === 'local' && state.settings.search && online() && L.needsSearch(userMsg.text)) {
        setStatus(id, 'searching');
        const res = await raceAbort(webSearch(userMsg.text), ctrl.signal).catch((e) => { if (e && e.code) throw e; return []; });
        if (res.length) { setStatus(id, 'reading'); extra = L.searchPrompt(res); sources = res; }
      }
      const system = L.systemPrompt({
        ai, nameOf, aiList: state.ais.filter((a) => a.enabled), now: new Date().toISOString().slice(0, 10),
        memory: L.pickMemory(state.memory, userMsg.text, 6), offline: !online(), extra,
      });
      const messages = L.buildMessages({ ai, history: state.messages, upToId: userMsg.id, nameOf, system, maxFull: state.settings.contextN });
      if (sources) setStatus(id, 'reading'); else setStatus(id, 'thinking');
      const text = await callChat(ai, messages, {
        signal: ctrl.signal,
        onDelta: (t) => {
          if (!msg) {
            got = true; setStatus(id, 'writing');
            msg = { id: uid(), role: 'ai', authorId: id, text: '', ts: Date.now(), streaming: true, replyTo: userMsg.id, sources };
            state.messages.push(msg);
          }
          msg.text = t; scheduleRender(msg);
        },
      });
      if (!msg) { msg = { id: uid(), role: 'ai', authorId: id, text, ts: Date.now(), replyTo: userMsg.id, sources }; state.messages.push(msg); }
      msg.text = text; msg.streaming = false;
      if (!L.stripThink(text).trim()) { msg.error = true; renderMsg(msg); throw { code: 'empty' }; }
      renderMsg(msg); save();
      setStatus(id, 'done', { ms: Date.now() - t0 });
    } catch (e) {
      const info = L.classifyError(e, ai);
      if (msg) { msg.streaming = false; if (!msg.text) { state.messages = state.messages.filter((x) => x !== msg); els.get(msg.id) && els.get(msg.id).remove(); els.delete(msg.id); } else renderMsg(msg); }
      /* NVIDIA 모델 이름이 안 맞으면 목록에서 알아서 골라 한 번 더 */
      if (info.kind === 'model' && ai.id === 'nvidia' && !tried.pick && ai.key) {
        try {
          const list = await fetchModels(ai);
          const pick = MODEL_PREF.map((re) => list.find((m) => re.test(m))).find(Boolean);
          if (pick && pick !== ai.model) { ai.model = pick; save(); note(`NVIDIA 모델을 ${pick} 로 바꿨어요 (이전 이름이 목록에 없었어요)`); return askAI(ai, userMsg, { pick: true }); }
        } catch (e2) { /* 안내만 */ }
      }
      if (info.kind === 'ratelimit' && !tried.wait) {
        setStatus(id, 'wait', { hint: info.hint });
        for (let s = info.retryAfter; s > 0 && !(ctrl.signal.aborted); s--) { setStatus(id, 'wait', { text: `한도 초과, ${s}초 뒤 재시도`, hint: info.hint }); await sleep(1000); }
        clearTimeout(slow); clearTimeout(hard);
        if (ctrl.signal.aborted) { ctrls.delete(id); setStatus(id, 'stopped'); return; }
        ctrls.delete(id);
        return askAI(ai, userMsg, Object.assign({}, tried, { wait: true }));
      }
      setStatus(id, info.kind === 'stopped' ? 'stopped' : 'error', { text: info.text, hint: info.hint });
    } finally { clearTimeout(slow); clearTimeout(hard); if (ctrls.get(id) === ctrl) ctrls.delete(id); updateStop(); save(); }
  }
  function retry(id) {
    const um = state.messages.find((m) => m.id === lastUserFor[id]) || [...state.messages].reverse().find((m) => m.role === 'user');
    if (um) askAI(aiById(id), um);
  }

  async function send(raw) {
    const text = raw.trim();
    if (!text) return;
    if (handleCommand(text)) return;
    const enabled = state.ais.filter((a) => a.enabled);
    if (!enabled.length) { note('켜져 있는 AI가 없어요. ⚙ 설정에서 켜 주세요.'); return; }
    const call = L.findCalls(text, enabled);
    const um = { id: uid(), role: 'user', text, ts: Date.now(), to: call.mode === 'direct' ? call.ids : [] };
    state.messages.push(um); renderMsg(um); save(); toBottom();
    await Promise.allSettled(call.ids.map((id) => askAI(aiById(id), um)));
  }

  /* ---------- 입력창 ---------- */
  function autosize() { const i = $('#input'); i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, window.innerHeight * 0.3) + 'px'; }
  $('#input').addEventListener('input', autosize);
  $('#composer').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const i = $('#input'), v = i.value; i.value = ''; autosize(); send(v);
  });
  $('#btnStop').addEventListener('click', () => ctrls.forEach((c) => c.abort(Object.assign(new Error('stopped'), { code: 'stopped' }))));
  $('#statusToggle').addEventListener('click', () => {
    const b = $('#statusBody'); b.hidden = !b.hidden; $('#statusToggle').textContent = 'AI 상태 ' + (b.hidden ? '▸' : '▾');
  });
  window.addEventListener('online', renderTip); window.addEventListener('offline', renderTip);

  /* ---------- 설정 ---------- */
  function openSettings() { renderSettings(); $('#sheet').hidden = false; }
  function closeSettings() { $('#sheet').hidden = true; save(); renderStatus(); renderChips(); }
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnCloseSheet').addEventListener('click', closeSettings);

  function parseAliases(s) { return String(s).split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean); }

  function renderSettings() {
    const body = $('#sheetBody'); body.innerHTML = '';
    body.append(h('p', { class: 'help', text: '키는 이 폰 안에만 저장돼요. 별명을 지으면 그 이름으로 부를 수 있어요 (예: "딥이야 이거 뭐야?").' }));
    state.ais.forEach((a) => {
      const res = h('div', { class: 'res' });
      const dl = h('datalist', { id: 'dl-' + a.id });
      const model = h('input', { type: 'text', value: a.model, list: 'dl-' + a.id, autocapitalize: 'off', autocomplete: 'off', oninput: (ev) => { a.model = ev.target.value.trim(); save(); } });
      const card = h('div', { class: 'card', style: '--c:' + a.color },
        h('h3', {}, h('span', { text: `${a.label}  ·  ${a.kind === 'local' ? '폰 안에서 (인터넷 없이)' : '인터넷'}` }),
          h('label', { class: 'sw' }, h('input', { type: 'checkbox', checked: a.enabled, onchange: (ev) => { a.enabled = ev.target.checked; save(); } }), '켜기')),
        h('label', { text: '별명 (비우면 모델 이름으로 불러요)' }),
        h('input', { type: 'text', value: a.nickname, placeholder: '예: 딥이', onchange: (ev) => {
          const old = a.nickname; a.nickname = ev.target.value.trim();
          const c = L.findAliasConflict(state.ais);
          if (c) { a.nickname = old; ev.target.value = old; res.className = 'res bad'; res.textContent = `"${c.name}" 은(는) 이미 다른 AI의 이름이에요.`; } else { save(); res.textContent = ''; }
        } }),
        h('label', { text: '다른 별명 (쉼표로 여러 개)' }),
        h('input', { type: 'text', value: (a.aliases || []).join(', '), placeholder: '예: 디피, 딥시크', onchange: (ev) => {
          const old = a.aliases; a.aliases = parseAliases(ev.target.value);
          const c = L.findAliasConflict(state.ais);
          if (c) { a.aliases = old; ev.target.value = old.join(', '); res.className = 'res bad'; res.textContent = `"${c.name}" 은(는) 이미 다른 AI의 이름이에요.`; } else { save(); res.textContent = ''; }
        } }),
        h('label', { text: a.kind === 'local' ? 'API 키 (로컬은 비워도 돼요)' : 'API 키' }),
        h('div', { class: 'row' },
          h('input', { type: 'password', value: a.key, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', oninput: (ev) => { a.key = ev.target.value.trim(); save(); renderTip(); } }),
          h('button', { type: 'button', text: '👁', onclick: (ev) => { const i = ev.target.previousSibling; i.type = i.type === 'password' ? 'text' : 'password'; } })),
        h('label', { text: '모델' }),
        h('div', { class: 'row' }, model, dl,
          h('button', { type: 'button', text: '목록', onclick: async () => {
            res.className = 'res'; res.textContent = '불러오는 중…';
            try { const list = await fetchModels(a); dl.innerHTML = ''; list.forEach((m) => dl.append(h('option', { value: m }))); res.className = 'res ok'; res.textContent = `모델 ${list.length}개. 모델 칸을 눌러 고르세요.`; }
            catch (e) { const i = L.classifyError(e, a); res.className = 'res bad'; res.textContent = i.text + ' — ' + i.hint; }
          } })),
        h('label', { text: '주소 (보통 그대로)' }),
        h('input', { type: 'url', value: a.base, oninput: (ev) => { a.base = ev.target.value.trim(); save(); } }),
        h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { type: 'button', text: '연결 테스트', onclick: async () => {
          res.className = 'res'; res.textContent = '확인 중…'; const t0 = Date.now();
          try {
            if (a.kind !== 'local' && !a.key) throw { code: 'nokey' };
            const t = await callChat(a, [{ role: 'user', content: '한 단어로 "ok" 라고만 답해.' }], { extraBody: { max_tokens: 400 } });
            res.className = 'res ok'; res.textContent = `✓ 연결됨 (${((Date.now() - t0) / 1000).toFixed(1)}초) — ${L.stripThink(t).slice(0, 40) || '(빈 답)'}`;
          } catch (e) { const i = L.classifyError(e, a); res.className = 'res bad'; res.textContent = `✗ ${i.text}\n👉 ${i.hint}`; }
        } })),
        res);
      body.append(card);
    });

    body.append(h('div', { class: 'sec', text: '로컬 AI 검색' }),
      h('label', { class: 'sw' }, h('input', { type: 'checkbox', checked: state.settings.search, onchange: (ev) => { state.settings.search = ev.target.checked; save(); } }),
        '인터넷이 되면 검색해서 읽고, 생각해서 답하기'),
      h('p', { class: 'help', text: '인터넷이 없으면 검색은 건너뛰고 아는 것과 기억으로만 답해요.' }));

    body.append(h('div', { class: 'sec', text: '대화 맥락 (토큰 절약)' }),
      h('select', { onchange: (ev) => { state.settings.contextN = +ev.target.value; save(); } },
        [6, 12, 20].map((n) => h('option', { value: n, selected: state.settings.contextN === n, text: `최근 ${n}개 메시지만 그대로 보내기 (나머지는 한 줄 요약)` }))));

    const memBox = h('div');
    const drawMem = () => {
      memBox.innerHTML = '';
      if (!state.memory.length) memBox.append(h('p', { class: 'help', text: '아직 없어요. 대화창에 "기억해: …" 라고 하면 쌓여요.' }));
      state.memory.forEach((m) => memBox.append(h('div', { class: 'mem' }, h('span', { text: m.text }),
        h('button', { type: 'button', text: '✕', onclick: () => { state.memory = state.memory.filter((x) => x.id !== m.id); save(); drawMem(); } }))));
    };
    body.append(h('div', { class: 'sec', text: '모두가 공유하는 기억' }), memBox); drawMem();

    body.append(h('div', { class: 'sec', text: '대화' }),
      h('button', { type: 'button', text: '대화 모두 지우기 (기억은 남아요)', onclick: () => { if (confirm('대화를 모두 지울까요?')) { state.messages = []; save(); renderAll(); closeSettings(); } } }));
  }

  /* ---------- 시작 ---------- */
  load(); renderAll(); renderChips(); renderStatus(); autosize();
  window.__aigc = { state, send, askAI }; // 테스트용
})();
