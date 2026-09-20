// 轻量 Markdown -> 安全 HTML 渲染器(零依赖)
// 安全策略:先把整段文本做 HTML 转义,再在转义后的字符串上做正则替换生成标签,
// 这样用户内容里的 <script> 等无法注入(XSS 防护)。
(function (global) {
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 行内:加粗 / 斜体 / 删除线。已处理"代码保护占位"的内容上做替换。
  function inlineBoldItalic(s) {
    return s
      .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^**_])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[^*_])\_([^_\n]+)\_/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  }

  // URL 协议白名单:仅允许相对路径、锚点与 http/https/mailto,拦截 javascript: 等危险协议。
  function safeUrl(u) {
    u = u.trim();
    if (/^(https?:|mailto:|#|\/(?!\/)|\.\/|\.\.\/)/i.test(u)) return u;
    return null;
  }

  // 行内链接与图片(在已转义文本上做,src/href 里的引号已被转义)。URL 含括号或危险协议则不成链接,保留为纯文本。
  function inlineLink(s) {
    s = s.replace(/!\[([^\]]*)\]\(([^()\s]+)\)/g, (m, alt, src) => {
      const u = safeUrl(src);
      return u ? '<img src="' + u + '" alt="' + alt + '" loading="lazy">' : alt;
    });
    s = s.replace(/\[([^\]]+)\]\(([^()\s]+)\)/g, (m, text, href) => {
      const u = safeUrl(href);
      return u ? '<a href="' + u + '" target="_blank" rel="noopener">' + text + '</a>' : text;
    });
    return s;
  }

  // 行内整体处理:先保护行内代码,再处理其余,最后还原代码
  // 用控制字符 \x01 作占位符,正文里不会出现,避免与转义后内容冲突。
  function inline(s) {
    const PH = String.fromCharCode(1);
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (m, c) => { codes.push('<code>' + c + '</code>'); return PH + (codes.length - 1) + PH; });
    s = inlineLink(s);
    s = inlineBoldItalic(s);
    s = s.replace(new RegExp(PH + '(\\d+)' + PH, 'g'), (m, i) => codes[Number(i)]);
    return s;
  }

  function render(src) {
    if (!src) return '';
    const escaped = escapeHtml(src).replace(/\r\n/g, '\n');
    const lines = escaped.split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // 围栏代码块
      const fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        const lang = fence[1];
        const buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // 跳过闭合
        out.push('<pre><code' + (lang ? ' class="lang-' + escapeHtml(lang) + '"' : '') + '>' + buf.join('\n') + '</code></pre>');
        continue;
      }

      // 空行
      if (!line.trim()) { i++; out.push(''); continue; }

      // 标题
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const level = h[1].length;
        out.push('<h' + level + '>' + inline(h[2]) + '</h' + level + '>');
        i++;
        continue;
      }

      // 水平线
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

      // 引用(连续 > 行合并成一个 blockquote 内的多个 p)
      if (/^&gt;\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^&gt;\s?/.test(lines[i])) { buf.push(lines[i].replace(/^&gt;\s?/, '')); i++; }
        out.push('<blockquote>' + buf.map((l) => inline(l) || '<br>').join('<br>') + '</blockquote>');
        continue;
      }

      // 无序列表(连续 -/*/+ 开头行合并)
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) {
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(/^\s*[-*+]\s+(.*)$/);
          if (!m) break;
          items.push('<li>' + inline(m[1]) + '</li>');
          i++;
        }
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }

      // 有序列表
      const ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ol) {
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(/^\s*\d+\.\s+(.*)$/);
          if (!m) break;
          items.push('<li>' + inline(m[1]) + '</li>');
          i++;
        }
        out.push('<ol>' + items.join('') + '</ol>');
        continue;
      }

      // 普通段落:合并连续非空、非块级开头的行为一个 <p>
      const para = [];
      while (i < lines.length && lines[i].trim()) {
        const t = lines[i];
        if (/^(```|#{1,6}\s|&gt;\s?|[-*+]\s|\d+\.\s)/.test(t)) break;
        para.push(t);
        i++;
      }
      out.push('<p>' + inline(para.join(' ')) + '</p>');
    }

    return out.join('\n');
  }

  const api = { render };
  const scope = typeof window !== 'undefined' ? window : globalThis;
  scope.Markdown = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);