// 企业微信推送封装：群机器人 webhook（path/91770）+ 自建应用消息（path/90236）
// 重试由调用方（index.js）统一控制，本模块只负责单次 API 调用

const API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';

async function postJson(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (data.errcode !== 0) {
    throw new Error(`企业微信接口错误 errcode=${data.errcode} errmsg=${data.errmsg}`);
  }
  return data;
}

// ---------- 群机器人 ----------

export async function sendImageToGroup(webhookKey, imageBytes) {
  const bytes = new Uint8Array(imageBytes);
  const base64 = bytesToBase64(bytes);
  const md5 = md5Hex(bytes);
  return postJson(`${API_BASE}/webhook/send?key=${encodeURIComponent(webhookKey)}`, {
    msgtype: 'image',
    image: { base64, md5 },
  });
}

export async function sendTextToGroup(webhookKey, content, mentionedList = [], mentionedMobileList = []) {
  const body = { msgtype: 'text', text: { content } };
  if (mentionedList.length) body.text.mentioned_list = mentionedList;
  if (mentionedMobileList.length) body.text.mentioned_mobile_list = mentionedMobileList;
  return postJson(`${API_BASE}/webhook/send?key=${encodeURIComponent(webhookKey)}`, body);
}

// ---------- 自建应用 ----------

export async function getAccessToken(corpId, corpSecret) {
  const url = `${API_BASE}/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.errcode !== 0) {
    throw new Error(`获取 access_token 失败 errcode=${data.errcode} errmsg=${data.errmsg}`);
  }
  return data.access_token;
}

// 上传图片素材；FormData 在闭包内部创建，支持调用方重试
export async function uploadImage(token, imageBytes) {
  const form = new FormData();
  form.append('media', new Blob([imageBytes], { type: 'image/png' }), 'mail-screenshot.png');
  const resp = await fetch(`${API_BASE}/media/upload?access_token=${token}&type=image`, {
    method: 'POST',
    body: form,
  });
  const data = await resp.json();
  if (data.errcode !== 0) {
    throw new Error(`素材上传失败 errcode=${data.errcode} errmsg=${data.errmsg}`);
  }
  return data.media_id;
}

export async function sendAppImage(token, agentId, mediaId, touser) {
  return postJson(`${API_BASE}/message/send?access_token=${token}`, {
    touser,
    msgtype: 'image',
    agentid: agentId,
    image: { media_id: mediaId },
  });
}

// ---------- 编码工具 ----------

function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function md5Hex(bytes) {
  const K = [];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const len = bytes.length;
  const bitLen = len * 8;
  const paddedLen = (((len + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, bitLen >>> 0, true);
  view.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const rotl = (x, c) => (x << c) | (x >>> (32 - c));
  for (let off = 0; off < paddedLen; off += 64) {
    const M = new Array(16);
    for (let j = 0; j < 16; j++) M[j] = view.getUint32(off + j * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  out.setUint32(0, a0, true); out.setUint32(4, b0, true);
  out.setUint32(8, c0, true); out.setUint32(12, d0, true);
  return [...new Uint8Array(out.buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}