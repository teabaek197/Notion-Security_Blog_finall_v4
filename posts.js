// GET /api/posts  → { posts: 글 목록, menus: type=Menu 페이지(About 등) }
const { getEnv, pageToPost, queryAllRows, isPublic, isMenu } = require('./_notion');

module.exports = async function handler(req, res) {
  try {
    const { dbId } = getEnv();
    const all = (await queryAllRows(dbId))
      .map(pageToPost)
      .filter(isPublic)
      .map(({ hasPassword, ...rest }) => rest);

    // type 이 Menu 인 행은 글 목록/카테고리에서 빼고 따로 내려준다 (About 등)
    const posts = all.filter((p) => !isMenu(p));
    const menus = all.filter(isMenu).map(({ id, title, slug, type }) => ({ id, title, slug, type }));

    // 60초 캐시 + 백그라운드 갱신 → 노션 수정 후 최대 ~1분 내 반영
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({ posts, menus });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
