const test = require('node:test');
const assert = require('node:assert');
const L = require('../www/logic.js');

const ais = [
  { id: 'nvidia', label: 'NVIDIA', model: 'deepseek-ai/deepseek-v4-flash', nickname: '딥이', aliases: ['디피'], kind: 'cloud' },
  { id: 'groq', label: 'Groq', model: 'openai/gpt-oss-120b', nickname: '', aliases: [], kind: 'cloud' },
  { id: 'openrouter', label: 'OpenRouter', model: 'openrouter/free', nickname: '', aliases: [], kind: 'cloud' },
  { id: 'local', label: '로컬', model: 'qwen2.5:3b', nickname: '', aliases: [], kind: 'local' },
];
const calls = (t) => L.findCalls(t, ais);

test('이름 없으면 전원', () => {
  const r = calls('오늘 점심 뭐 먹지?');
  assert.equal(r.mode, 'all'); assert.equal(r.ids.length, 4);
});
test('별명으로 한 명만', () => {
  for (const t of ['딥이야 이거 뭐야?', '@딥이 이거 뭐야', '딥이, 이거 뭐야', '이거 뭐야 딥이야', '딥이는 어떻게 생각해?']) {
    const r = calls(t); assert.deepEqual([r.mode, r.ids], ['direct', ['nvidia']], t);
  }
});
test('추가 별명 · 모델 이름 · 서비스 이름', () => {
  assert.deepEqual(calls('디피야 안녕').ids, ['nvidia']);
  assert.deepEqual(calls('deepseek야 안녕').ids, ['nvidia']);
  assert.deepEqual(calls('groq야 안녕').ids, ['groq']);
  assert.deepEqual(calls('gpt-oss-120b 이거 뭐야').ids, ['groq']);
  assert.deepEqual(calls('로컬아 안녕').ids, ['local']);
});
test('두 명 이상 호출', () => {
  const r = calls('딥이랑 로컬은 어떻게 생각해?');
  assert.deepEqual(r.ids.sort(), ['local', 'nvidia']);
});
test('다른 AI 말을 언급만 하면 전원 답함', () => {
  const r = calls('방금 딥이 말에 대해 어떻게 생각해?');
  assert.equal(r.mode, 'all');
});
test('전체 호출', () => {
  assert.equal(calls('다들 어떻게 생각해?').mode, 'all');
  assert.equal(calls('@all 안녕').ids.length, 4);
});
test('영문 대소문자', () => {
  assert.deepEqual(calls('DeepSeek야 안녕').ids, ['nvidia']);
});
test('별명 중복 금지', () => {
  const dup = [{ id: 'a', nickname: '딥이', aliases: [] }, { id: 'b', nickname: '', aliases: ['딥이'] }];
  assert.ok(L.findAliasConflict(dup));
  assert.equal(L.findAliasConflict(ais), null);
});
test('명령어', () => {
  assert.deepEqual(L.parseCommand('기억해: 내 폰은 램 12GB'), { type: 'remember', arg: '내 폰은 램 12GB' });
  assert.deepEqual(L.parseCommand('/기억 별명은 딥이'), { type: 'remember', arg: '별명은 딥이' });
  assert.deepEqual(L.parseCommand('/잊어 램'), { type: 'forget', arg: '램' });
  assert.equal(L.parseCommand('/기억목록').type, 'list');
  assert.equal(L.parseCommand('안녕'), null);
});
test('맥락 만들기: 내 말은 assistant, 남의 말은 이름표 붙은 user', () => {
  const names = { nvidia: '딥이', groq: 'gpt-oss', local: '로컬' };
  const nameOf = (id) => names[id] || id;
  const history = [
    { id: '1', role: 'user', text: '안녕', to: [] },
    { id: '2', role: 'ai', authorId: 'nvidia', text: '반가워' },
    { id: '3', role: 'ai', authorId: 'groq', text: '안녕하세요' },
    { id: '4', role: 'user', text: '딥이 말에 동의해?', to: [] },
    { id: '5', role: 'ai', authorId: 'groq', text: '나중 답(포함되면 안 됨)' },
  ];
  const m = L.buildMessages({ ai: ais[0], history, upToId: '4', nameOf, system: 'SYS' });
  assert.equal(m[0].content, 'SYS');
  assert.deepEqual(m.map((x) => x.role), ['system', 'user', 'assistant', 'user']);
  assert.match(m[1].content, /\[사용자\] 안녕/);
  assert.equal(m[2].content, '반가워');
  assert.match(m[3].content, /\[gpt-oss\] 안녕하세요/);
  assert.match(m[3].content, /\[사용자\] 딥이 말에 동의해\?/);
  assert.ok(!m.some((x) => x.content.includes('나중 답')));
});
test('오래된 대화는 요약으로 줄임', () => {
  const history = [];
  for (let i = 0; i < 30; i++) history.push({ id: 'u' + i, role: 'user', text: '긴 말 '.repeat(50) + i, to: [] });
  const m = L.buildMessages({ ai: ais[0], history, nameOf: (x) => x, system: 'S', maxFull: 12 });
  /* 요약과 최근 메시지는 같은 user 턴으로 합쳐진다. 요약 부분만 본다 */
  assert.match(m[1].content, /^\[이전 대화 요약\]/);
  const summary = m[1].content.split('\n\n')[0];
  assert.equal(summary.split('\n').length, 1 + 18);
  assert.ok(summary.length < 18 * 130);
  assert.ok(m[1].content.includes('긴 말 '.repeat(50) + '29'));
});
test('기억 고르기', () => {
  const mem = Array.from({ length: 20 }, (_, i) => ({ text: '관련 없는 메모 ' + i }));
  mem.push({ text: '내 폰은 갤럭시 램 12GB' });
  const picked = L.pickMemory(mem, '내 폰 램이 몇이었지', 6).map((x) => x.text);
  assert.ok(picked.includes('내 폰은 갤럭시 램 12GB'));
  assert.equal(L.pickMemory(mem.slice(0, 3), '아무거나').length, 3);
});
test('think 태그 제거', () => {
  assert.equal(L.stripThink('<think>생각</think>답'), '답');
  assert.equal(L.stripThink('<think>아직 생각 중'), '');
});
test('검색 필요 판단', () => {
  assert.ok(L.needsSearch('오늘 서울 날씨 어때?'));
  assert.ok(!L.needsSearch('ㅋㅋ'));
  assert.ok(!L.needsSearch('/기억목록'));
});
test('DuckDuckGo 파싱', () => {
  const html = `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">제목 <b>하나</b></a>
  <a class="result__snippet" href="x">요약 &amp; 설명 <b>강조</b></a>`;
  const r = L.parseDdg(html);
  assert.deepEqual(r, [{ title: '제목 하나', snippet: '요약 & 설명 강조', url: 'https://example.com/a' }]);
});
test('위키 파싱', () => {
  const r = L.parseWiki({ query: { search: [{ title: '서울 특별시', snippet: '<span class="x">서울</span>은 수도' }] } });
  assert.equal(r[0].snippet, '서울은 수도');
  assert.match(r[0].url, /ko\.wikipedia\.org\/wiki\/%EC%84%9C/);
});
test('오류 안내', () => {
  const g = ais[1];
  assert.equal(L.classifyError(new L.HttpError(429, '', '40'), g).retryAfter, 40);
  assert.equal(L.classifyError(new L.HttpError(401, ''), g).kind, 'auth');
  assert.equal(L.classifyError(new L.HttpError(404, ''), g).kind, 'model');
  assert.match(L.classifyError(new TypeError('Failed to fetch'), ais[3]).hint, /Termux/);
  assert.equal(L.classifyError({ code: 'nokey' }, g).kind, 'auth');
});
test('시스템 프롬프트에 이름·기억·검색이 들어감', () => {
  const nameOf = (id) => ({ nvidia: '딥이', groq: 'gpt-oss', openrouter: 'OR', local: '로컬' })[id];
  const s = L.systemPrompt({ ai: ais[0], aiList: ais, nameOf, memory: [{ text: '폰 램 12GB' }], now: '2026-11-11', offline: true });
  assert.match(s, /"딥이"/); assert.match(s, /gpt-oss, OR, 로컬/); assert.match(s, /폰 램 12GB/); assert.match(s, /인터넷이 없어서/);
});
