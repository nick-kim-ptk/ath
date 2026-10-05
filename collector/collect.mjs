// 지구 근황 · 매일 자정(KST) 수집기
//  1) 구글 트렌드 "급상승 검색어" RSS (19개국)  2) Claude가 화제로 정리  3) Supabase에 저장
// 키는 코드에 쓰지 않고 GitHub Secrets에서만 읽어요: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SECRET_KEY
// DRY_RUN=1 이면 Supabase에는 쓰지 않고 결과만 보여줘요(처음 시험할 때 쓰세요).
import { appendFileSync } from 'node:fs';

const DRY = process.env.DRY_RUN === '1';
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const ONLY = (process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean);   // 예: ONLY=JP,KR (시험용)
const { ANTHROPIC_API_KEY, SUPABASE_SECRET_KEY, PEXELS_API_KEY } = process.env;
/* 주소 뒤에 /rest/v1 같은 경로가 붙어 있어도 https://….supabase.co 부분만 써요 */
let SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
try { if (SUPABASE_URL) SUPABASE_URL = new URL(SUPABASE_URL).origin; } catch { throw new Error('SUPABASE_URL 이 주소 모양이 아니에요: https://xxxx.supabase.co 형태로 넣어주세요'); }
if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY 가 없어요 (GitHub Secrets 확인)');
if (!DRY && (!SUPABASE_URL || !SUPABASE_SECRET_KEY)) throw new Error('SUPABASE_URL / SUPABASE_SECRET_KEY 가 없어요 (GitHub Secrets 확인)');

/* 앱의 나라 코드 -> 구글 트렌드 geo, 한국어 이름, 대표 도시 id (CN은 구글 트렌드가 지원하지 않아 제외) */
const COUNTRIES = {
  KR: ['KR', '한국', 'seoul'], JP: ['JP', '일본', 'tokyo'], US: ['US', '미국', 'newyork'], FR: ['FR', '프랑스', 'paris'],
  UK: ['GB', '영국', 'london'], IT: ['IT', '이탈리아', 'rome'], BR: ['BR', '브라질', 'saopaulo'], AU: ['AU', '호주', 'sydney'],
  TH: ['TH', '태국', 'bangkok'], DE: ['DE', '독일', 'berlin'], ES: ['ES', '스페인', 'madrid'], TR: ['TR', '튀르키예', 'istanbul'],
  CA: ['CA', '캐나다', 'toronto'], MX: ['MX', '멕시코', 'mexicocity'], IN: ['IN', '인도', 'mumbai'], ID: ['ID', '인도네시아', 'jakarta'],
  VN: ['VN', '베트남', 'hochiminh'], SG: ['SG', '싱가포르', 'singapore'], TW: ['TW', '대만', 'taipei']
};
const CATS = ['food', 'tech', 'life', 'culture', 'fashion', 'wellness', 'travel'];
const STATUSES = ['hot', 'rising', 'new', 'talked'];

const kstDate = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const TODAY = kstDate(), STAMP = TODAY.replace(/-/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/* ---------- 1. RSS ---------- */
const tag = (s, t) => { const m = s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : ''; };
export function parseRss(xml) {
  return xml.split('<item>').slice(1).map(it => ({
    term: tag(it, 'title'),
    traffic: parseInt((tag(it, 'ht:approx_traffic').replace(/[^0-9]/g, '')) || '0', 10),
    news: it.split('<ht:news_item>').slice(1).map(n => ({ title: tag(n, 'ht:news_item_title'), source: tag(n, 'ht:news_item_source'), url: tag(n, 'ht:news_item_url') })).filter(n => n.title)
  })).filter(i => i.term);
}
async function fetchTrends(geo) {
  const r = await fetch(`https://trends.google.com/trending/rss?geo=${geo}`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; earth-lately-collector)' } });
  if (!r.ok) throw new Error('RSS ' + r.status);
  return parseRss(await r.text());
}

/* ---------- 2. Claude ---------- */
async function claude(system, user, maxTokens = 3500) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
    });
    if (r.status === 429 || r.status >= 500) { await sleep(4000 * attempt); continue; }
    if (!r.ok) throw new Error('Claude ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    const text = (j.content || []).map(c => c.text || '').join('');
    const m = text.match(/\{[\s\S]*\}/);
    try {
      if (!m) throw new Error('JSON 없음');
      return JSON.parse(m[0]);
    } catch (e) { lastErr = e; await sleep(1500); continue; }   // 모양이 깨졌으면 같은 요청을 다시 보내요
  }
  throw new Error('Claude 재시도 초과' + (lastErr ? ': ' + lastErr.message : ''));
}

const SYSTEM = `너는 '지구 근황' 앱의 에디터야. 나라별 구글 트렌드 급상승 검색어와 관련 뉴스 제목을 받아서, 한국 사용자가 "지금 그 나라에서 뭐가 화제인지" 한눈에 알 수 있게 정리해.
규칙:
- 입력 항목 중 화제로 소개할 만한 것 3~4개만 골라. 같은 이슈를 가리키는 항목은 하나로 합쳐.
- 제외: 복권 번호, 로그인/사이트 이름 같은 도구성 검색어, 뜻을 알 수 없는 것, 사건·사고·범죄·구속·재판·사망 소식, 재난 피해자 중심 기사, 개인 사생활·가십·연예인 신변 이야기, 선정적인 것. 정치는 사실 전달만 하고 의견은 쓰지 마.
- 소개할 만한 것: 제품·서비스·음식·유행·행사·날씨와 계절 이야기·경기와 대회 결과·경제와 기술 소식처럼 사람들이 함께 이야기하는 주제.
- title은 뉴스 헤드라인이 아니라 '화제의 이름'이야. 12자 안팎의 명사형으로 짧게 (예: '스테이블코인 확산', '가을 곰 출몰'). 사건의 세부 내용은 short와 what에 써.
- 오직 입력으로 받은 뉴스 제목에 담긴 사실만 써. 모르는 건 지어내지 말고, 근거가 부족한 항목은 고르지 마. 숫자·날짜·이름을 새로 만들지 마.
- 기사 문장을 그대로 옮기지 말고 네 말로 짧게 요약해. 한국어, 부드러운 '~요' 체.
- 글 안에서는 큰따옴표(\")를 쓰지 말고 작은따옴표(')를 써. 줄바꿈도 넣지 마.
- 각 화제는 이런 JSON 모양이야 (JSON만 출력, 다른 말 금지):
{"topics":[{"items":[입력 항목 번호들],"keyword":"한국어 키워드 2~8자","slug":"english-kebab-case","title":"화제 이름 12자 안팎","en":"English Title","short":"한 줄 요약 40자 이내","status":"hot|rising|new","category":"food|tech|life|culture|fashion|wellness|travel","area":"그 나라 안의 도시나 지역 이름(나라 이름은 쓰지 말고, 모르면 빈 문자열)","photo":"사진 검색어(영어 2~4단어) 또는 빈 문자열","why":["왜 화제인지 짧은 구 3개"],"what":[{"head":"소제목","text":"한두 문장"},{"head":"","text":""},{"head":"","text":""}],"news":[{"ref":"항목번호:뉴스번호","title":"기사 제목을 한국어로 옮긴 것","summary":"한 줄 요약"}]}]}
- photo: 이 화제의 분위기를 보여주는 일반적인 장면을 영어 검색어로 (예: 'autumn forest', 'stock market screen', 'tennis court'). 실존 인물 이름, 특정 팀·브랜드·사건 이름은 쓰지 마. 인물·정치·사건이 중심이면 빈 문자열.
- status: 검색량이 가장 크거나 가장 큰 화제는 hot, 나머지는 rising 또는 new. category는 어울리는 걸 고르되 스포츠·사회·날씨는 culture 또는 life.
- news는 화제당 2개(없으면 1개). ref는 입력에 있는 번호만 써.`;

function promptFor(cc, items) {
  const lines = items.map((it, i) => `#${i} ${it.term} (검색량 ${it.traffic}+)\n` + it.news.slice(0, 3).map((n, j) => `  ${i}:${j} [${n.source}] ${n.title}`).join('\n'));
  return `나라: ${COUNTRIES[cc][1]} (${cc})\n오늘 날짜: ${TODAY}\n\n${lines.join('\n')}`;
}

/* 한 나라 -> 검증된 화제 목록 */
async function buildCountry(cc, prevSlugs) {
  const items = await fetchTrends(COUNTRIES[cc][0]);
  if (!items.length) throw new Error('항목 없음');
  const out = await claude(SYSTEM, promptFor(cc, items));
  const topics = [], rej = { 근거부족: 0, 뉴스없음: 0, 내용부족: 0, slug없음: 0 };
  for (const t of out.topics || []) {
    const idx = (t.items || []).filter(i => Number.isInteger(i) && items[i]);
    const news = (t.news || []).map(n => {
      const [a, b] = String(n.ref || '').split(':').map(Number);
      const src = items[a]?.news?.[b];
      return src && n.title && n.summary ? { title: String(n.title).slice(0, 120), source: src.source || '출처', url: src.url || null, summary: String(n.summary).slice(0, 160) } : null;
    }).filter(Boolean);
    /* Claude가 모양을 조금 다르게 줘도 읽어요: 글자만 / [제목,글] / {head|title, text|body} */
    const what = (Array.isArray(t.what) ? t.what : []).map(w => {
      if (typeof w === 'string') return { head: '무슨 일이에요', text: w };
      if (Array.isArray(w)) return { head: String(w[0] || ''), text: String(w[1] || '') };
      return w ? { head: String(w.head || w.title || ''), text: String(w.text || w.body || w.desc || '') } : null;
    }).filter(w => w && w.text).map(w => ({ head: (w.head || '무슨 일이에요').slice(0, 30), text: w.text.slice(0, 160) })).slice(0, 3);
    const why = (Array.isArray(t.why) ? t.why : []).map(x => typeof x === 'string' ? x : (x && (x.text || x.reason || x.head)) || '').filter(Boolean).map(x => String(x).slice(0, 40)).slice(0, 3);
    if (!idx.length || !t.title || !t.short) { rej.근거부족++; continue; }   // 근거가 부족하면 버려요
    if (!news.length) { rej.뉴스없음++; continue; }
    if (!what.length || !why.length) { rej.내용부족++; if (!rej.예시) rej.예시 = `${Object.keys(t).join(',')} | what=${JSON.stringify(t.what).slice(0, 80)} | why=${JSON.stringify(t.why).slice(0, 60)}`; continue; }
    const slug = String(t.slug || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!slug) { rej.slug없음++; continue; }
    topics.push({
      slug, keyword: String(t.keyword || t.title).slice(0, 16), title: String(t.title).slice(0, 30), en: String(t.en || t.title).slice(0, 40), short: String(t.short).slice(0, 60),
      status: STATUSES.includes(t.status) ? t.status : 'rising', category: CATS.includes(t.category) ? t.category : 'life',
      area: (a => (Object.values(COUNTRIES).some(c => c[1] === a) ? '' : a))(String(t.area || '').trim().slice(0, 12)), photoQuery: String(t.photo || '').replace(/[^\w\s-]/g, ' ').trim().slice(0, 40), why, what, news,
      traffic: Math.max(...idx.map(i => items[i].traffic))
    });
  }
  if (!topics.length) throw new Error(`쓸 만한 화제가 없어요 (후보 ${items.length}개 중 Claude가 고른 ${(out.topics || []).length}개, 버려진 이유: ${JSON.stringify(rej)}, 상위 검색어: ${items.slice(0, 5).map(i => i.term).join(' / ')})`);
  topics.sort((a, b) => b.traffic - a.traffic);
  topics.slice(0, 4).forEach((t, i) => { if (i === 0) t.status = 'hot'; else if (t.status === 'hot') t.status = 'rising'; if (prevSlugs.has(t.slug) && i > 0) t.status = 'talked'; });
  return topics.slice(0, 4);
}


/* ---------- 사진 (Pexels 무료 스톡 사진) ---------- */
const usedPhotos = new Set();
async function findPhoto(query) {
  if (!PEXELS_API_KEY || !query) return null;
  try {
    const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=8&orientation=landscape`, { headers: { Authorization: PEXELS_API_KEY } });
    if (!r.ok) return null;
    const j = await r.json();
    const p = (j.photos || []).find(x => !usedPhotos.has(x.id) && x.width >= 1000);
    if (!p) return null;
    usedPhotos.add(p.id);
    return { url: p.src.large, credit: String(p.photographer || '').slice(0, 40), link: p.url };
  } catch { return null; }
}

/* ---------- 3. Supabase ---------- */
const H = { apikey: SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + SUPABASE_SECRET_KEY, 'content-type': 'application/json' };
async function sb(method, path, body, prefer) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, { method, headers: { ...H, ...(prefer ? { Prefer: prefer } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}
const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export async function main() {
  const targets = Object.keys(COUNTRIES).filter(cc => !ONLY.length || ONLY.includes(cc));
  /* 어제 있던 slug (같은 화제가 이어지면 ONGOING) */
  const prev = {};
  if (!DRY) (await sb('GET', 'trends?select=cc,keyword_id&is_sample=eq.false')).forEach(r => { (prev[r.cc] = prev[r.cc] || new Set()).add(r.keyword_id); });

  const results = {}, failed = [];
  for (const cc of targets) {
    try { results[cc] = await buildCountry(cc, prev[cc] || new Set()); log(`✓ ${cc} 화제 ${results[cc].length}개`); }
    catch (e) { failed.push(`${cc}: ${e.message}`); log(`✗ ${cc} ${e.message}`); }
    await sleep(1500);
  }
  const done = Object.keys(results);
  if (!done.length) throw new Error('모든 나라가 실패했어요');

  /* 나라 사이에 같은 이야기면 한 키워드로 묶기 */
  const flat = done.flatMap(cc => results[cc].map((t, i) => ({ id: `${cc}#${i}`, cc, t })));
  try {
    const g = await claude('같은 이야기를 다루는 화제를 서로 다른 나라끼리 묶는 도우미야. JSON만 출력해.',
      `아래는 나라별 화제야. 서로 다른 나라에서 실질적으로 같은 사건·주제인 것만 묶어줘(비슷한 분야라는 이유만으로는 묶지 마).\n` +
      flat.map(f => `${f.id} | ${f.t.keyword} | ${f.t.title} | ${f.t.slug}`).join('\n') +
      `\n\n출력: {"groups":[{"slug":"english-kebab","title":"한국어 키워드 2~8자","members":["KR#0","JP#1"]}]} (묶을 게 없으면 {"groups":[]})`, 1500);
    for (const grp of g.groups || []) {
      const ms = (grp.members || []).map(id => flat.find(f => f.id === id)).filter(Boolean);
      if (new Set(ms.map(m => m.cc)).size < 2) continue;
      const slug = String(grp.slug || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
      if (!slug) continue;
      ms.forEach(m => { m.t.slug = slug; m.t.keyword = String(grp.title || m.t.keyword).slice(0, 16); });
    }
  } catch (e) { log('묶기 단계 건너뜀:', e.message); }

  /* 사진 찾기 (키가 없으면 건너뛰어요) */
  for (const cc of done) for (const t of results[cc]) { t.photo = await findPhoto(t.photoQuery); await sleep(300); }

  if (DRY) {
    console.log(JSON.stringify(Object.fromEntries(done.map(cc => [cc, results[cc]])), null, 1));
  } else {
    /* 새 행을 먼저 넣고, 그 나라의 예전 행(샘플 포함)을 지워서 빈 시간이 없게 해요 */
    const kws = new Map();
    flat.forEach(f => kws.set(f.t.slug, f.t.keyword));
    await sb('POST', 'keywords?on_conflict=id', [...kws].map(([id, title]) => ({ id, title })), 'resolution=merge-duplicates,return=minimal');
    for (const cc of done) {
      const rows = results[cc].map((t, i) => ({
        id: `${cc.toLowerCase()}-${STAMP}-${i + 1}`, keyword_id: t.slug, cc, city_id: COUNTRIES[cc][2], area: t.area || null,
        title: t.title, title_en: t.en, short_desc: t.short, status: t.status, category: t.category, pattern: hash(t.title) % 8,
        why: t.why, what: t.what, heat: Math.round(Math.log10(Math.max(t.traffic, 10)) * 100) / 100, is_sample: false, image_url: t.photo ? t.photo.url : null, image_credit: t.photo ? t.photo.credit : null, image_link: t.photo ? t.photo.link : null,
        published_at: new Date().toISOString(), expires_at: new Date(Date.now() + 36 * 3600e3).toISOString()
      }));
      await sb('POST', 'trends?on_conflict=id', rows, 'resolution=merge-duplicates,return=minimal');
      const ids = rows.map(r => r.id);
      await sb('DELETE', `trend_news?trend_id=in.(${ids.join(',')})`);
      const news = results[cc].flatMap((t, i) => t.news.map(n => ({ trend_id: ids[i], title: n.title, source: n.source, published_on: TODAY, summary: n.summary, url: n.url, is_sample: false })));
      await sb('POST', 'trend_news', news, 'return=minimal');
      await sb('DELETE', `trends?cc=eq.${cc}&id=not.in.(${ids.join(',')})`);
    }
    /* 어디에도 안 쓰이고 아무도 Keep하지 않은 키워드는 정리 */
    const [allKw, used, kept] = await Promise.all([sb('GET', 'keywords?select=id'), sb('GET', 'trends?select=keyword_id'), sb('GET', 'keeps?select=keyword_id')]);
    const live = new Set([...used.map(r => r.keyword_id), ...kept.map(r => r.keyword_id)]);
    const orphan = allKw.map(r => r.id).filter(id => !live.has(id));
    for (let i = 0; i < orphan.length; i += 50) await sb('DELETE', `keywords?id=in.(${orphan.slice(i, i + 50).map(encodeURIComponent).join(',')})`);
  }

  const summary = `## 수집 결과 (${TODAY}${DRY ? ', 시험 실행: 저장 안 함' : ''})\n성공 ${done.length}개국 / 실패 ${failed.length}개국\n\n` +
    done.map(cc => `- **${cc}** ${results[cc].map(t => `${t.title}(${t.status}${t.photo ? ', 사진 있음' : ''})`).join(', ')}`).join('\n') + (failed.length ? `\n\n실패:\n${failed.map(f => '- ' + f).join('\n')}` : '') + '\n';
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
