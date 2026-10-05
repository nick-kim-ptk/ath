// 구글 트렌드 "급상승 검색어" RSS가 GitHub Actions(클라우드)에서 열리는지 확인하는 테스트입니다.
// 키가 필요 없고, 아무것도 저장하지 않아요. 결과 표는 Actions 실행 화면 맨 아래(Summary)에 나와요.
import { appendFileSync } from 'node:fs';

const GEO = { KR:'KR', JP:'JP', CN:'CN', US:'US', FR:'FR', UK:'GB', IT:'IT', BR:'BR', AU:'AU', TH:'TH',
              DE:'DE', ES:'ES', TR:'TR', CA:'CA', MX:'MX', IN:'IN', ID:'ID', VN:'VN', SG:'SG', TW:'TW' };

const tag = (s, t) => (s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() || '';

let rows = '| 나라 | 결과 | 항목 수 | 뉴스 있는 항목 | 맨 위 3개 |\n|---|---|---|---|---|\n';
let ok = 0;
for (const [cc, geo] of Object.entries(GEO)) {
  try {
    const r = await fetch(`https://trends.google.com/trending/rss?geo=${geo}`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; earth-lately-probe)' } });
    const xml = await r.text();
    const items = xml.split('<item>').slice(1);
    const withNews = items.filter(i => i.includes('<ht:news_item>')).length;
    const top = items.slice(0, 3).map(i => tag(i, 'title')).join(' / ').replace(/\|/g, '/');
    rows += `| ${cc} | ${r.status} | ${items.length} | ${withNews} | ${top} |\n`;
    if (r.ok && items.length) ok++;
  } catch (e) {
    rows += `| ${cc} | 오류: ${String(e.message).slice(0, 40)} | 0 | 0 |  |\n`;
  }
  await new Promise(r => setTimeout(r, 1500)); // 천천히 요청해서 차단을 피해요
}
const out = `## 구글 트렌드 RSS 테스트: ${ok}/${Object.keys(GEO).length}개 나라 성공\n\n${rows}`;
console.log(out);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out);
