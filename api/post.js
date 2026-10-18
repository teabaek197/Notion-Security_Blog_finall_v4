// GET /api/post?id=<pageId>  → 글 본문(HTML 변환)
const { notion, getEnv, pageToPost, plain } = require('./_notion');

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function safeUrl(u) {
  return /^https?:\/\//i.test(u || '') ? esc(u) : '#';
}

function rich(arr) {
  return (arr || [])
    .map((t) => {
      let s = esc(t.plain_text).replace(/\n/g, '<br>');
      const a = t.annotations || {};
      if (a.code) s = `<code class="px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-800 text-emerald-600 dark:text-emerald-400 code-font text-[0.85em]">${s}</code>`;
      if (a.bold) s = `<strong>${s}</strong>`;
      if (a.italic) s = `<em>${s}</em>`;
      if (a.strikethrough) s = `<del>${s}</del>`;
      if (a.underline) s = `<u>${s}</u>`;
      if (t.href) s = `<a href="${safeUrl(t.href)}" target="_blank" rel="noopener noreferrer" class="text-emerald-500 underline">${s}</a>`;
      return s;
    })
    .join('');
}

async function fetchChildren(blockId) {
  let all = [];
  let cursor;
  do {
    const q = `?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`;
    const data = await notion(`/blocks/${blockId}/children${q}`);
    all = all.concat(data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return all;
}

const unsupported = [];

async function blocksToHtml(blocks) {
  let html = '';
  let listType = null;

  const closeList = () => {
    if (listType) { html += listType === 'ul' ? '</ul>' : '</ol>'; listType = null; }
  };

  for (const b of blocks) {
    const d = b[b.type] || {};
    const isLi = b.type === 'bulleted_list_item' || b.type === 'numbered_list_item';
    if (!isLi) closeList();

    let children = '';
    if (b.has_children && b.type !== 'child_page' && b.type !== 'child_database') {
      // 동기화 블록(복제본)은 원본 블록의 자식을 읽는다
      const cid = b.type === 'synced_block' && d.synced_from ? d.synced_from.block_id : b.id;
      children = await blocksToHtml(await fetchChildren(cid));
    }

    switch (b.type) {
      case 'paragraph':
        html += d.rich_text.length ? `<p>${rich(d.rich_text)}</p>${children}` : '<br>';
        break;
      case 'heading_1':
        html += `<h2 class="text-xl font-bold text-emerald-500 mt-6">${rich(d.rich_text)}</h2>${children}`; break;
      case 'heading_2':
        html += `<h3 class="text-lg font-bold text-emerald-500 mt-5">${rich(d.rich_text)}</h3>${children}`; break;
      case 'heading_3':
        html += `<h4 class="font-semibold text-emerald-500 mt-4">${rich(d.rich_text)}</h4>${children}`; break;
      case 'bulleted_list_item':
      case 'numbered_list_item': {
        const t = b.type === 'bulleted_list_item' ? 'ul' : 'ol';
        if (listType !== t) {
          closeList();
          html += t === 'ul' ? '<ul class="list-disc pl-6 space-y-1">' : '<ol class="list-decimal pl-6 space-y-1">';
          listType = t;
        }
        html += `<li>${rich(d.rich_text)}${children}</li>`;
        break;
      }
      case 'to_do':
        html += `<p>${d.checked ? '☑' : '☐'} ${rich(d.rich_text)}</p>`; break;
      case 'quote':
        html += `<blockquote class="border-l-4 border-emerald-500/60 pl-4 italic text-zinc-500 dark:text-zinc-400">${rich(d.rich_text)}</blockquote>`; break;
      case 'callout':
        html += `<div class="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20">${d.icon && d.icon.emoji ? d.icon.emoji + ' ' : ''}${rich(d.rich_text)}${children}</div>`; break;
      case 'code':
        html += `<pre class="p-4 rounded-xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 overflow-x-auto text-xs code-font"><code>${esc(plain(d.rich_text))}</code></pre>`; break;
      case 'divider':
        html += '<hr class="border-zinc-200 dark:border-zinc-800">'; break;
      case 'toggle':
        html += `<details class="rounded-xl border border-zinc-200 dark:border-zinc-800 p-3"><summary class="cursor-pointer font-medium">${rich(d.rich_text)}</summary><div class="mt-2 space-y-2">${children}</div></details>`; break;
      case 'image': {
        const url = d.type === 'external' ? d.external.url : d.file.url;
        const cap = plain(d.caption);
        html += `<figure><img src="${safeUrl(url)}" alt="${esc(cap)}" class="rounded-xl max-w-full" loading="lazy">${cap ? `<figcaption class="text-xs text-zinc-500 mt-1">${esc(cap)}</figcaption>` : ''}</figure>`;
        break;
      }
      case 'child_page':
      case 'link_to_page': {
        const pid = b.type === 'child_page' ? b.id : (d.page_id || '');
        if (!pid) break;
        const label = b.type === 'child_page' ? d.title : '연결된 페이지';
        html += `<button type="button" data-page-id="${esc(pid)}" class="w-full text-left flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 hover:border-emerald-500/60 hover:text-emerald-500 transition cursor-pointer"><span><i class="fa-regular fa-file-lines mr-2 text-emerald-500"></i>${esc(label || '제목 없음')}</span><i class="fa-solid fa-arrow-right text-[10px]"></i></button>`;
        break;
      }
      case 'child_database': {
        // 페이지 안에 만든 인라인 데이터베이스 → 안의 페이지들을 링크로 나열
        try {
          const q = await notion(`/databases/${b.id}/query`, { method: 'POST', body: { page_size: 100 } });
          html += `<div class="space-y-2"><p class="text-xs text-zinc-500">${esc(d.title || '')}</p>` +
            q.results.map((pg) => {
              const t = pageToPost(pg).title || '제목 없음';
              return `<button type="button" data-page-id="${esc(pg.id)}" class="w-full text-left flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 hover:border-emerald-500/60 hover:text-emerald-500 transition cursor-pointer"><span><i class="fa-regular fa-file-lines mr-2 text-emerald-500"></i>${esc(t)}</span><i class="fa-solid fa-arrow-right text-[10px]"></i></button>`;
            }).join('') + '</div>';
        } catch (e) { /* 접근 권한이 없으면 건너뜀 */ }
        break;
      }
      case 'file':
      case 'pdf':
      case 'video':
      case 'audio': {
        const url = d.type === 'external' ? d.external.url : (d.file && d.file.url);
        if (url) html += `<p><a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer" class="text-emerald-500 underline"><i class="fa-solid fa-paperclip mr-1"></i>${esc(plain(d.caption) || (d.name || '첨부 파일'))}</a></p>`;
        break;
      }
      case 'equation':
        html += `<pre class="code-font text-xs">${esc(d.expression)}</pre>`; break;
      case 'bookmark':
      case 'embed':
      case 'link_preview':
        html += `<p><a href="${safeUrl(d.url)}" target="_blank" rel="noopener noreferrer" class="text-emerald-500 underline">${esc(d.url)}</a></p>`; break;
      case 'table': {
        const rows = await fetchChildren(b.id);
        html += '<div class="overflow-x-auto"><table class="w-full text-sm border border-zinc-200 dark:border-zinc-800">';
        rows.forEach((r, i) => {
          const tag = i === 0 && d.has_column_header ? 'th' : 'td';
          html += '<tr>' + r.table_row.cells
            .map((c) => `<${tag} class="border border-zinc-200 dark:border-zinc-800 px-3 py-2 text-left">${rich(c)}</${tag}>`)
            .join('') + '</tr>';
        });
        html += '</table></div>';
        break;
      }
      case 'table_of_contents':
      case 'breadcrumb':
        break;
      default:
        if (d.rich_text && d.rich_text.length) {
          html += `<p>${rich(d.rich_text)}</p>${children}`;
        } else if (children) {
          html += children;
        } else {
          unsupported.push(b.type);
          html += `<p class="text-xs text-zinc-400 code-font">[표시할 수 없는 블록: ${esc(b.type)}]</p>`;
        }
    }
  }
  closeList();
  return html;
}

module.exports = async function handler(req, res) {
  try {
    const id = String(req.query.id || '');
    if (!/^[0-9a-f-]{32,36}$/i.test(id)) {
      return res.status(400).json({ error: 'invalid id' });
    }

    const { dbId } = getEnv();
    const norm = (s) => String(s || '').replace(/-/g, '').toLowerCase();

    const page = await notion(`/pages/${id}`);

    // 부모를 따라 올라가 (1) 설정한 DB 소속인지 확인 (2) 경로(breadcrumb) 수집
    let node = page;
    const ancestors = []; // 가까운 부모 → 루트 순
    let root = null;
    for (let i = 0; i < 15; i++) {
      const p = node.parent;
      if (!p) break;
      if (p.type === 'database_id') {
        if (norm(p.database_id) === norm(dbId)) { root = node; break; }
        // 다른(인라인) DB 안의 페이지 → DB의 부모를 따라 계속 위로 추적
        node = await notion(`/databases/${p.database_id}`);
        continue;
      }
      if (p.type === 'page_id') {
        node = await notion(`/pages/${p.page_id}`);
        ancestors.push({ id: node.id, title: pageToPost(node).title || '제목 없음' });
      } else if (p.type === 'block_id') {
        node = await notion(`/blocks/${p.block_id}`); // 토글/컬럼 안의 페이지
      } else {
        break;
      }
    }
    if (!root) return res.status(403).json({ error: '허용되지 않은 페이지입니다.' });

    // 공개 여부는 루트(DB 항목) 기준으로 판단
    const rootPost = pageToPost(root);
    if (rootPost.hasPassword || (rootPost.status && rootPost.status.toLowerCase() !== 'published')) {
      return res.status(403).json({ error: '공개되지 않은 글입니다.' });
    }

    const post = pageToPost(page);
    unsupported.length = 0; // 요청마다 초기화
    const topBlocks = await fetchChildren(id);
    const content = await blocksToHtml(topBlocks);
    const visibleText = content.replace(/<br\s*\/?>/g, '').replace(/<[^>]*>/g, '').trim();
    const empty = !visibleText && !/data-page-id|<img/.test(content);
    const blockTypes = {};
    topBlocks.forEach((b) => { blockTypes[b.type] = (blockTypes[b.type] || 0) + 1; });
    const { hasPassword, ...rest } = post;
    const isRoot = page.id === root.id;

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({
      post: {
        ...rest,
        category: isRoot ? rest.category : rootPost.category,
        date: isRoot ? rest.date : rootPost.date,
        isSubPage: !isRoot,
        path: ancestors.reverse(), // 루트 → 직전 부모
        content,
        empty,
        blockTypes,
        unsupported: [...unsupported],
        version: 'v4',
      },
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
