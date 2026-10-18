// GET /api/posts  → 노션 데이터베이스의 글 목록
const { notion, getEnv, pageToPost } = require('./_notion');

module.exports = async function handler(req, res) {
  try {
    const { dbId } = getEnv();
    let results = [];
    let cursor;

    do {
      const data = await notion(`/databases/${dbId}/query`, {
        method: 'POST',
        body: { page_size: 100, start_cursor: cursor },
      });
      results = results.concat(data.results);
      cursor = data.has_more ? data.next_cursor : undefined;
    } while (cursor);

    const posts = results
      .map(pageToPost)
      .filter((p) => p.title)
      // 상태 속성이 있으면 Published 만 공개 (없으면 전부 공개)
      .filter((p) => !p.status || p.status.toLowerCase() === 'published')
      // 비밀번호가 걸린 글은 목록에서 제외
      .filter((p) => !p.hasPassword)
      .map(({ hasPassword, ...rest }) => rest);

    // 60초 캐시 + 백그라운드 갱신 → 노션 수정 후 최대 ~1분 내 반영
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({ posts });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
