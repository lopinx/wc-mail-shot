// EML（RFC 822/MIME）解析：提取主题、发件人、日期、正文 HTML
// 目标邮件为 WooCommerce 订单通知等模板化邮件，仅覆盖常见编码场景

// 解析 eml 原文，返回 { subject, from, date, html }
export function parseEml(eml) {
  // 换行统一为 \n
  const normalized = eml.replace(/\r\n/g, '\n');
  const headerEnd = normalized.indexOf('\n\n');
  const headerPart = headerEnd >= 0 ? normalized.slice(0, headerEnd) : normalized;
  const bodyPart = headerEnd >= 0 ? normalized.slice(headerEnd + 2) : '';

  const headers = unfoldHeaders(headerPart);
  const subject = decodeHeader(headers.get('subject') ?? '');
  const from = decodeHeader(headers.get('from') ?? '');
  const date = headers.get('date') ?? '';

  const { html, text } = extractBodies(bodyPart, headers.get('content-type') ?? '', headers);
  // 去掉纯文本正文结尾由 EML 格式带来的换行
  return { subject, from, date, html, text: text.replace(/\n+$/, '') };
}

// 头部折叠：续行以空格/Tab 开头，合并到上一行
function unfoldHeaders(part) {
  const lines = [];
  for (const line of part.split('\n')) {
    if (/^[ \t]/.test(line) && lines.length) {
      lines[lines.length - 1] += ' ' + line.trim();
    } else if (line.trim()) {
      lines.push(line);
    }
  }
  const map = new Map();
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    map.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  }
  return map;
}

// 解析 Content-Type 头部参数，如 charset、boundary
function contentTypeParams(value) {
  const params = new Map();
  const parts = value.split(';');
  for (const part of parts.slice(1)) {
    const m = part.trim().match(/^([\w-]+)\s*=\s*"?([^";]+)"?/);
    if (m) params.set(m[1].toLowerCase(), m[2]);
  }
  return params;
}

// 从正文中提取 HTML 与纯文本：支持 multipart/alternative、multipart/mixed 与单 part
function extractBodies(body, topLevelContentType, headers) {
  const ct = topLevelContentType.toLowerCase();
  const boundary = contentTypeParams(topLevelContentType).get('boundary');

  if (ct.startsWith('multipart/') && boundary) {
    let html = '';
    let text = '';
    for (const part of splitMultipart(body, boundary)) {
      const pEnd = part.indexOf('\n\n');
      if (pEnd < 0) continue;
      const pHeaders = unfoldHeaders(part.slice(0, pEnd));
      const pCt = pHeaders.get('content-type') ?? 'text/plain';
      const found = extractBodies(part.slice(pEnd + 2), pCt, pHeaders);
      if (found.html && !html) html = found.html;
      if (found.text && !text) text = found.text;
    }
    return { html, text };
  }

  if (ct.startsWith('text/html')) return { html: decodeBody(body, headers), text: '' };
  if (ct.startsWith('text/plain')) return { html: '', text: decodeBody(body, headers) };
  return { html: '', text: '' };
}

function splitMultipart(body, boundary) {
  const delim = '--' + boundary;
  const parts = [];
  let start = body.indexOf(delim);
  while (start >= 0) {
    start = body.indexOf('\n', start);
    if (start < 0) break;
    start += 1;
    const end = body.indexOf('\n' + delim, start);
    if (end < 0) break;
    parts.push(body.slice(start, end));
    // 结束符 --boundary-- 后不再有内容
    if (body.slice(end + 1 + delim.length).startsWith('--')) break;
    start = end + 1;
  }
  return parts;
}

// 按 Content-Transfer-Encoding 解码正文
function decodeBody(body, headers) {
  const enc = (headers.get('content-transfer-encoding') ?? '').toLowerCase();
  const charset = (contentTypeParams(headers.get('content-type') ?? '').get('charset') ?? 'utf-8').toLowerCase();
  if (enc === 'base64') {
    return decodeBytes(base64ToBytes(body.replace(/\s/g, '')), charset);
  }
  if (enc === 'quoted-printable') {
    return decodeBytes(quotedPrintableToBytes(body), charset);
  }
  return body;
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function quotedPrintableToBytes(text) {
  const out = [];
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    while (line.endsWith('=')) {
      line = line.slice(0, -1);
      li += 1;
      line += lines[li] ?? '';
    }
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '=' && i + 2 < line.length + 1) {
        const hex = line.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          out.push(parseInt(hex, 16));
          i += 2;
          continue;
        }
      }
      out.push(line.charCodeAt(i));
    }
    if (li < lines.length - 1) out.push(10);
  }
  return new Uint8Array(out);
}

function decodeBytes(bytes, charset) {
  if (charset === 'utf-8' || charset === 'utf8') return new TextDecoder('utf-8').decode(bytes);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// 解码 RFC 2047 编码词（=?charset?B/Q?...?=）
function decodeHeader(value) {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, type, data) => {
    const cs = charset.toLowerCase();
    if (type.toUpperCase() === 'B') {
      return decodeBytes(base64ToBytes(data), cs);
    }
    const bytes = quotedPrintableToBytes(data.replace(/_/g, ' '));
    return decodeBytes(bytes, cs);
  });
}