// GET /api/search-index
// 공개된 글과 그 하위 페이지(몇 단계든)의 제목+본문 텍스트를 모아 검색용 인덱스를 만든다.
// 노션 API는 본문 검색을 지원하지 않으므로 직접 수집하고, 결과는 Vercel 캐시에 보관한다.
const { notion, getEnv, pageToPost, queryAllRows, isPublic, isMenu } = require('./_notion');

const CONCURRENCY = 4;      // 노션으로 동시에 보내는 요청 수
const BUDGET_MS = 50000;    // 이 시간이 지나면 모은 만큼만 응답 (partial)
const MAX_PAGES = 200;      // 안전 상한
const MAX_BLOCK_DEPTH = 6;  // 토글/목록 안쪽 블록 깊이
const TEXT_CAP = 30000;     // 페이지당 저장할 본문 최대 글자 수

// 동시 실행 수 제한
let active = 0;
const waiting = [];
async function limited(fn) {
  if (active >= CONCURRENCY) await new Promise((r) => waiting.push(r));
  active++;
  try { return await fn(); }
  finally { active--; const next = waiting.shift(); if (next) next(); }
}

async function children(blockId) {
  const out = [];
  let cursor;
  do {
    const d = await limited(() =>
      notion(`/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`));
    out.push(...d.results);
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor);
  return out;
}

const rt = (arr) => (arr || []).map((t) => t.plain_text).join('');

function blockText(b) {
  const d = b[b.type] || {};
  let t = '';
  if (Array.isArray(d.rich_text)) t = rt(d.rich_text);
  else if (b.type === 'table_row') t = (d.cells || []).map(rt).join(' ');
  else if (b.type === 'equation') t = d.expression || '';
  if (Array.isArray(d.caption)) t += ' ' + rt(d.caption);
  return t;
}

// 한 블록(페이지) 아래의 텍스트를 순서대로 모으고, 하위 페이지/DB는 ctx.subs 에 담는다
async function collectText(blockId, depth, ctx) {
  const blocks = await children(blockId);
  const parts = await Promise.all(blocks.map(async (b) => {
    if (b.type === 'child_page') { ctx.subs.push({ id: b.id, title: b.child_page.title }); return ''; }
    if (b.type === 'child_database') { ctx.subs.push({ dbId: b.id, title: b.child_database.title }); return ''; }
    let t = blockText(b);
    if (b.has_children && depth < MAX_BLOCK_DEPTH && Date.now() < ctx.deadline) {
      const cid = b.type === 'synced_block' && b[b.type].synced_from ? b[b.type].synced_from.block_id : b.id;
      t += ' ' + (await collectText(cid, depth + 1, ctx));
    }
    return t;
  }));
  return parts.filter((x) => x && x.trim()).join('\n');
}

module.exports = async function handler(req, res) {
  const started = Date.now();
  const deadline = started + BUDGET_MS;
  try {
    const { dbId } = getEnv();
    const rows = (await queryAllRows(dbId))
      .map((pg) => ({ pg, post: pageToPost(pg) }))
      .filter(({ post }) => isPublic(post) && !isMenu(post));

    let level = rows.map(({ pg, post }) => ({ id: pg.id, title: post.title, path: [] }));
    const seen = new Set(level.map((n) => n.id));
    const entries = [];
    let partial = false;

    while (level.length) {
      if (Date.now() >= deadline || entries.length >= MAX_PAGES) { partial = true; break; }
      const next = [];
      await Promise.all(level.map(async (node) => {
        if (Date.now() >= deadline || entries.length >= MAX_PAGES) { partial = true; return; }
        const ctx = { subs: [], deadline };
        let text = '';
        try { text = await collectText(node.id, 0, ctx); } catch (e) { /* 접근 불가 페이지는 제목만 */ }
        entries.push({ id: node.id, title: node.title, path: node.path, text: text.slice(0, TEXT_CAP) });

        const childPath = [...node.path, node.title];
        for (const sub of ctx.subs) {
          if (sub.id && !seen.has(sub.id)) {
            seen.add(sub.id);
            next.push({ id: sub.id, title: sub.title || '제목 없음', path: childPath });
          } else if (sub.dbId) {
            try {
              for (const pg of await queryAllRows(sub.dbId)) {
                if (seen.has(pg.id)) continue;
                seen.add(pg.id);
                next.push({ id: pg.id, title: pageToPost(pg).title || '제목 없음', path: childPath });
              }
            } catch (e) { /* 권한 없는 인라인 DB는 건너뜀 */ }
          }
        }
      }));
      level = next;
    }

    // 5분 캐시 + 1시간 동안은 낡은 결과를 먼저 보여주고 뒤에서 갱신
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    res.status(200).json({
      version: 'v9',
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - started,
      partial,
      entries,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
