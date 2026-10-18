// GET /api/debug  → 노션 연결 상태 진단 (토큰은 절대 출력하지 않음)
const { notion, getEnv, pageToPost } = require('./_notion');

const norm = (s) => String(s || '').replace(/-/g, '').toLowerCase();

async function children(id) {
  const out = [];
  let cursor;
  do {
    const d = await notion(`/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
    out.push(...d.results);
    cursor = d.has_more ? d.next_cursor : undefined;
  } while (cursor);
  return out;
}

const count = (blocks) => {
  const c = {};
  blocks.forEach((b) => { c[b.type] = (c[b.type] || 0) + 1; });
  return c;
};

module.exports = async function handler(req, res) {
  const report = { version: 'v4', env: {}, database: null, rows: [] };
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { dbId } = getEnv();
    report.env = {
      NOTION_TOKEN: 'set',
      NOTION_DATABASE_ID: `${dbId.slice(0, 6)}…${dbId.slice(-4)}`,
    };

    try {
      const db = await notion(`/databases/${dbId}`);
      report.database = {
        ok: true,
        id_matches_env: norm(db.id) === norm(dbId),
        title: (db.title || []).map((t) => t.plain_text).join(''),
        parent: db.parent && db.parent.type,
        properties: Object.keys(db.properties || {}),
        has_data_sources: Array.isArray(db.data_sources) ? db.data_sources.length : 'n/a',
      };
    } catch (e) {
      report.database = { ok: false, error: e.message.slice(0, 300) };
    }

    const q = await notion(`/databases/${dbId}/query`, { method: 'POST', body: { page_size: 20 } });
    for (const pg of q.results) {
      const post = pageToPost(pg);
      // 공개 대상(Published, 비밀번호 없음)만 구조를 보여준다
      if (post.hasPassword || (post.status && post.status.toLowerCase() !== 'published')) continue;
      const row = {
        title: post.title,
        parent_type: pg.parent && pg.parent.type,
        parent_matches_env: pg.parent && norm(pg.parent.database_id) === norm(dbId),
        blocks: null,
        sub_pages: [],
      };
      try {
        const blocks = await children(pg.id);
        row.blocks = count(blocks);
        for (const b of blocks.filter((x) => x.type === 'child_page').slice(0, 10)) {
          const sub = { title: b.child_page.title };
          try { sub.blocks = count(await children(b.id)); } catch (e) { sub.error = e.message.slice(0, 200); }
          row.sub_pages.push(sub);
        }
      } catch (e) {
        row.error = e.message.slice(0, 300);
      }
      report.rows.push(row);
    }
    res.status(200).json(report);
  } catch (e) {
    report.error = e.message.slice(0, 500);
    res.status(e.status || 500).json(report);
  }
};
