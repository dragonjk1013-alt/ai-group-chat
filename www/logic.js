/* 화면과 무관한 순수 로직: 이름 호출, 별명, 맥락 만들기, 기억, 검색 파싱, 오류 안내 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChatLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  class HttpError extends Error {
    constructor(status, body, retryAfter) {
      super('HTTP ' + status);
      this.status = status;
      this.body = body || '';
      const n = parseInt(retryAfter, 10);
      this.retryAfter = isFinite(n) ? n : null;
    }
  }

  /* ---------- 이름 ---------- */
  function shortModel(id) {
    return String(id || '').split('/').pop().replace(/:free$/, '');
  }
  function displayName(ai) {
    if (ai.nickname && ai.nickname.trim()) return ai.nickname.trim();
    if (ai.model === 'openrouter/free') return 'OpenRouter 무료';
    return shortModel(ai.model);
  }
  /* 호출에 쓸 수 있는 모든 이름: 별명, 추가 별명, 모델 이름, 서비스 이름 */
  function namesOf(ai) {
    const out = [];
    const push = (n) => {
      n = String(n || '').trim();
      if (n.length < 2 || n.toLowerCase() === 'free') return;
      if (!out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n);
    };
    push(ai.nickname);
    (ai.aliases || []).forEach(push);
    push(displayName(ai));
    if (ai.model !== 'openrouter/free') {
      push(shortModel(ai.model));
      const fam = shortModel(ai.model).split(/[-_.\s]/)[0];
      if (fam.length >= 4) push(fam);
    }
    push(ai.label);
    return out;
  }
  /* 사용자가 직접 지은 이름(별명)이 두 AI에 겹치면 막는다 */
  function findAliasConflict(ais) {
    const seen = new Map();
    for (const ai of ais) {
      const mine = [ai.nickname].concat(ai.aliases || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
      for (const n of new Set(mine)) {
        if (seen.has(n) && seen.get(n) !== ai.id) return { name: n, a: seen.get(n), b: ai.id };
        seen.set(n, ai.id);
      }
    }
    return null;
  }

  /* ---------- 누구를 부르는가 ---------- */
  const BEFORE = '(?:^|[\\s,.!?(\\[“"\'])';
  const AFTER = '(?=$|[\\s,.!?:])';
  function directRegexes(name) {
    const n = escapeRe(name);
    return [
      new RegExp('@' + n + AFTER, 'i'),                                              // @딥이
      new RegExp(BEFORE + n + '(?:이야|야|아|님|씨|이여)' + AFTER, 'i'),                // 딥이야 / 딥아
      new RegExp(BEFORE + n + '\\s*[,:](?=\\s|$)', 'i'),                             // 딥이, ...
      new RegExp(BEFORE + n + '(?:이랑|랑|이와|와|과|한테|에게|께|도)' + AFTER, 'i'),    // 딥이랑 미스트랄은
      new RegExp('^\\s*' + n + '(?:이|은|는|가)?' + AFTER, 'i'),                      // 문장 맨 앞
    ];
  }
  const ALL_RE = /(?:^|\s)(?:@(?:all|everyone|전체|다들|모두)|다들|모두|전원|얘들아|애들아)(?=$|[\s,.!?])/i;

  function findCalls(text, ais) {
    const all = ais.map((a) => a.id);
    if (ALL_RE.test(text)) return { mode: 'all', ids: all };
    const ids = [];
    for (const ai of ais) {
      const hit = namesOf(ai).some((n) => directRegexes(n).some((re) => re.test(text)));
      if (hit) ids.push(ai.id);
    }
    /* "딥이랑 로컬은 어떻게 생각해?"처럼 이미 누굴 불렀다면, 이어 나온 "이름은/는"도 호출로 본다 */
    if (ids.length) {
      for (const ai of ais) {
        if (ids.includes(ai.id)) continue;
        const sub = namesOf(ai).some((n) => new RegExp(BEFORE + escapeRe(n) + '(?:은|는)' + AFTER, 'i').test(text));
        if (sub) ids.push(ai.id);
      }
    }
    return ids.length ? { mode: 'direct', ids } : { mode: 'all', ids: all };
  }

  /* ---------- 명령어(기억) ---------- */
  function parseCommand(text) {
    const t = String(text).trim();
    let m;
    if (/^\/기억목록$|^\/기억$/.test(t)) return { type: 'list' };
    if ((m = t.match(/^(?:\/기억|기억해\s*[:：]?)\s*(.+)$/s))) return { type: 'remember', arg: m[1].trim() };
    if ((m = t.match(/^(?:\/잊어|잊어\s*[:：])\s*(.+)$/s))) return { type: 'forget', arg: m[1].trim() };
    return null;
  }

  /* ---------- 기억 고르기 ---------- */
  function grams(s) {
    const set = new Set();
    String(s).toLowerCase().replace(/[^0-9a-z가-힣]+/g, ' ').trim().split(' ').forEach((w) => {
      if (!w) return;
      if (w.length <= 2) set.add(w);
      for (let i = 0; i < w.length - 1; i++) set.add(w.slice(i, i + 2));
    });
    return set;
  }
  function pickMemory(mem, query, k) {
    k = k || 6;
    if (mem.length <= 8) return mem.slice();
    const q = grams(query);
    const scored = mem.map((m, i) => {
      let s = 0;
      grams(m.text).forEach((g) => { if (q.has(g)) s++; });
      return { m, s, i };
    });
    const hit = scored.filter((x) => x.s >= 2).sort((a, b) => b.s - a.s || b.i - a.i).slice(0, k);
    const need = Math.min(3, k) - hit.length;
    const extra = need > 0 ? scored.filter((x) => !hit.includes(x)).slice(-need) : [];
    return hit.concat(extra).map((x) => x.m);
  }

  /* ---------- 프롬프트 ---------- */
  function systemPrompt(o) {
    const me = o.nameOf(o.ai.id);
    const others = o.aiList.filter((a) => a.id !== o.ai.id).map((a) => o.nameOf(a.id));
    return [
      `너는 사용자와 여러 AI가 함께 있는 단체 대화방의 참가자 "${me}"야. (실제 모델: ${o.ai.model})`,
      `다른 참가자: 사용자${others.length ? ', ' + others.join(', ') : ''}.`,
      '각 메시지 앞의 [이름]은 말한 사람이야. 너는 네 답만 쓰고 네 이름표는 붙이지 마.',
      '다른 AI의 말에 동의하거나 반박할 때는 그 이름을 직접 불러. 한국어로 답하고, 필요한 만큼 충분히 설명해.',
      '너는 Claude, GPT, Grok, Gemini 같은 다른 서비스의 모델인 척하지 마. 네 정체는 위에 적힌 모델이야.',
      `오늘 날짜: ${o.now}.`,
      o.memory && o.memory.length ? '[공유 기억 - 사용자가 알려준 것. 답에 반영해]\n' + o.memory.map((m) => '- ' + m.text).join('\n') : '',
      o.offline ? '지금은 인터넷이 없어서 아는 것과 위 기억만으로 답해야 해. 모르면 모른다고 해.' : '',
      o.extra || '',
    ].filter(Boolean).join('\n');
  }

  function clip(s, n) { s = String(s).replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n) + '…' : s; }

  function buildMessages(o) {
    const nameOf = o.nameOf;
    const maxFull = o.maxFull || 12, oldChars = o.oldChars || 100;
    let h = o.history.filter((m) => m.text && !m.note && !m.error && !m.streaming);
    if (o.upToId) {
      const i = h.findIndex((m) => m.id === o.upToId);
      if (i >= 0) h = h.slice(0, i + 1);
    }
    const label = (m) => {
      if (m.role === 'ai') return nameOf(m.authorId);
      return m.to && m.to.length ? '사용자 → ' + m.to.map(nameOf).join(', ') : '사용자';
    };
    const old = h.slice(0, Math.max(0, h.length - maxFull));
    const recent = h.slice(-maxFull);
    const msgs = [{ role: 'system', content: o.system }];
    const push = (role, content) => {
      const last = msgs[msgs.length - 1];
      if (last.role === role && role !== 'system') last.content += '\n\n' + content;
      else msgs.push({ role, content });
    };
    if (old.length) push('user', '[이전 대화 요약]\n' + old.map((m) => `- ${label(m)}: ${clip(m.text, oldChars)}`).join('\n'));
    recent.forEach((m) => {
      if (m.role === 'ai' && m.authorId === o.ai.id) push('assistant', m.text);
      else push('user', `[${label(m)}] ${m.text}`);
    });
    if (msgs[1] && msgs[1].role === 'assistant') msgs.splice(1, 0, { role: 'user', content: '[대화 시작]' });
    return msgs;
  }

  function stripThink(s) {
    return String(s || '').replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').replace(/^\s+/, '');
  }

  /* ---------- 검색 ---------- */
  function needsSearch(t) {
    t = String(t || '').trim();
    if (t.length < 5 || t[0] === '/') return false;
    return /[?？]|뭐|무엇|누구|언제|어디|왜|어떻게|얼마|최신|뉴스|알려|검색|찾아|날씨|가격|순위|차이|뜻|의미|what|who|when|where|why|how/i.test(t);
  }
  function stripTags(s) {
    return String(s).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function parseDdg(html) {
    const links = [...String(html).matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
    const snips = [...String(html).matchAll(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g)];
    return links.map((m, i) => {
      let url = m[1].replace(/&amp;/g, '&');
      const u = url.match(/[?&]uddg=([^&]+)/);
      if (u) { try { url = decodeURIComponent(u[1]); } catch (e) { /* 그대로 */ } }
      else if (url.startsWith('//')) url = 'https:' + url;
      return { title: stripTags(m[2]), snippet: snips[i] ? stripTags(snips[i][1]) : '', url };
    }).filter((r) => r.title);
  }
  function parseWiki(json) {
    const list = (json && json.query && json.query.search) || [];
    return list.map((r) => ({
      title: r.title, snippet: stripTags(r.snippet),
      url: 'https://ko.wikipedia.org/wiki/' + encodeURIComponent(String(r.title).replace(/ /g, '_')),
    }));
  }
  function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
  function searchPrompt(results) {
    return '[방금 인터넷에서 검색한 결과]\n' +
      results.map((r, i) => `[${i + 1}] ${r.title} - ${clip(r.snippet, 220)} (${domainOf(r.url)})`).join('\n') +
      '\n위 검색 결과를 읽고 내용을 비교·판단해서 네 말로 종합해 답해. 결과를 그대로 나열하거나 복사하지 마. ' +
      '결과끼리 어긋나면 그 점을 말하고, 근거가 약하면 모른다고 해. 근거는 [1], [2]처럼 번호로 표시해.';
  }

  /* ---------- 상태·오류 ---------- */
  const STATE_LABEL = {
    idle: '대기', thinking: '생각 중', searching: '검색 중', reading: '검색 결과 읽는 중',
    writing: '답하는 중', slow: '늦어지는 중', wait: '재시도 대기', done: '완료', error: '오류', stopped: '중지됨',
  };
  const ACTIVE = ['thinking', 'searching', 'reading', 'writing', 'slow', 'wait'];

  function classifyError(e, ai) {
    const label = (ai && ai.label) || 'AI';
    const local = ai && ai.kind === 'local';
    const code = e && e.code, st = e && e.status;
    const body = String((e && e.body) || '').slice(0, 160);
    if (code === 'nokey') return { kind: 'auth', text: '키 없음', hint: `설정(⚙)에서 ${label} API 키를 입력하세요` };
    if (code === 'offline') return { kind: 'offline', text: '오프라인', hint: '데이터/와이파이를 켜세요. 그동안은 로컬 AI에게 물어볼 수 있어요' };
    if (code === 'timeout') return { kind: 'timeout', text: '응답 없음', hint: '[다시]를 눌러 보세요. 계속되면 설정에서 모델을 바꿔 보세요' };
    if (code === 'stopped' || (e && e.name === 'AbortError')) return { kind: 'stopped', text: '중지됨', hint: '' };
    if (code === 'empty') return { kind: 'empty', text: '빈 답', hint: '[다시]를 눌러 보세요' };
    if (st === 401 || st === 403) return { kind: 'auth', text: '키 오류', hint: `${label} 키가 틀렸거나 만료됐어요. 설정에서 다시 넣어주세요` };
    if (st === 402) return { kind: 'pay', text: '결제 필요', hint: `${label} 잔액/결제 상태를 확인하세요 (OpenRouter는 잔액이 마이너스면 무료 모델도 막혀요)` };
    if (st === 429) {
      const s = e.retryAfter || 30;
      return { kind: 'ratelimit', text: '한도 초과', retryAfter: Math.min(s, 90), hint: `무료 한도에 걸렸어요. 잠시 뒤 자동으로 한 번 다시 시도해요. 급하면 다른 AI에게 먼저 물어보세요` };
    }
    if (st === 404 || st === 400 || st === 422) {
      return { kind: 'model', text: '모델 오류', hint: local ? `로컬 서버에 이 모델이 없어요. Termux에서 'ollama pull ${ai.model}' 을 실행하세요` : `모델 이름이 안 맞아요. 설정에서 '목록'을 눌러 모델을 고르세요${body ? ' (' + body + ')' : ''}` };
    }
    if (st >= 500) return { kind: 'server', text: '서버 바쁨', hint: `${label} 서버가 바빠요. 잠시 후 [다시]를 누르세요` };
    if (e instanceof TypeError || (e && /network|fetch|failed/i.test(e.message || ''))) {
      return local
        ? { kind: 'network', text: '로컬 서버 꺼짐', hint: "Termux에서 로컬 서버(ollama serve 또는 llama-server)를 먼저 실행하세요" }
        : { kind: 'network', text: '연결 실패', hint: '인터넷 연결을 확인하세요' };
    }
    return { kind: 'other', text: '오류', hint: (e && e.message) || '알 수 없는 오류' };
  }

  return {
    esc, HttpError, shortModel, displayName, namesOf, findAliasConflict, findCalls, parseCommand,
    pickMemory, systemPrompt, buildMessages, stripThink, needsSearch, parseDdg, parseWiki,
    searchPrompt, domainOf, classifyError, STATE_LABEL, ACTIVE,
  };
});
