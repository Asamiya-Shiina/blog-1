(async function () {
  const host = document.getElementById('postContent');
  const params = new URLSearchParams(location.search);
  const id = params.get('id');

  function fail(msg) {
    host.textContent = '';
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = msg;
    host.appendChild(p);
  }

  if (!id) return fail('文章不存在');

  let post;
  try {
    const res = await fetch('/api/posts/' + id);
    if (!res.ok) throw new Error('http ' + res.status);
    post = await res.json();
  } catch (e) {
    return fail('文章不存在或加载失败');
  }

  document.title = post.title + ' · Ciallo～(∠・ω< )⌒☆';
  host.textContent = '';

  const back = document.createElement('a');
  back.className = 'post-back';
  back.href = 'index.html';
  back.textContent = '← 返回首页';

  const h1 = document.createElement('h1');
  h1.className = 'post-title';
  h1.textContent = post.title;

  const meta = document.createElement('div');
  meta.className = 'post-page-meta';
  const d = document.createElement('span');
  d.textContent = post.created_at;
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = post.tag || '未分类';
  meta.append(d, tag);

  const body = document.createElement('div');
  body.className = 'md-body';
  if (typeof Markdown === 'undefined') {
    body.textContent = post.content; // markdown.js 加载失败时退化为纯文本,页面不空白
  } else {
    try { body.innerHTML = Markdown.render(post.content); }
    catch { body.textContent = '（正文渲染失败）'; }
  }

  host.append(back, h1, meta, body);
})();