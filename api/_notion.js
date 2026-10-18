// 공통 유틸: Notion API 호출 + 속성 파싱
const NOTION_VERSION = '2022-06-28';

function getEnv() {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DATABASE_ID;
  if (!token || !dbId) {
    const err = new Error('환경 변수 NOTION_TOKEN, NOTION_DATABASE_ID 를 Vercel에 설정해주세요.');
    err.status = 500;
    throw err;
  }
  return { token, dbId };
}

async function notion(path, { method = 'GET', body } = {}) {
  const { token } = getEnv();
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Notion API ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const plain = (arr) => (arr || []).map((t) => t.plain_text).join('');

// 속성 이름(대소문자 무시)으로 찾기
function findProp(props, names) {
  const keys = Object.keys(props);
  for (const n of names) {
    const k = keys.find((x) => x.toLowerCase() === n.toLowerCase());
    if (k) return props[k];
  }
  return null;
}

// 어떤 타입이든 문자열로 변환
function propToText(p) {
  if (!p) return '';
  switch (p.type) {
    case 'title': return plain(p.title);
    case 'rich_text': return plain(p.rich_text);
    case 'select': return p.select ? p.select.name : '';
    case 'multi_select': return p.multi_select.map((s) => s.name).join(', ');
    case 'status': return p.status ? p.status.name : '';
    case 'date': return p.date ? p.date.start : '';
    case 'url': return p.url || '';
    case 'checkbox': return p.checkbox ? 'true' : '';
    case 'number': return p.number == null ? '' : String(p.number);
    case 'created_time': return p.created_time;
    case 'last_edited_time': return p.last_edited_time;
    default: return '';
  }
}

function pageToPost(page) {
  const props = page.properties || {};
  const titleProp = Object.values(props).find((p) => p.type === 'title');
  const dateProp = findProp(props, ['date', 'Date', '날짜']);
  const date = propToText(dateProp) || page.created_time;

  return {
    id: page.id,
    title: propToText(titleProp),
    summary: propToText(findProp(props, ['summary', '요약'])),
    status: propToText(findProp(props, ['status', '상태'])),
    category: propToText(findProp(props, ['category', '카테고리'])),
    tags: propToText(findProp(props, ['tags', '태그'])),
    slug: propToText(findProp(props, ['slug'])),
    date: (date || '').slice(0, 10).replace(/-/g, '/'),
    hasPassword: !!propToText(findProp(props, ['password', '비밀번호'])),
    icon: page.icon && page.icon.type === 'emoji' ? page.icon.emoji : '',
  };
}

module.exports = { notion, getEnv, pageToPost, plain, propToText, findProp };
