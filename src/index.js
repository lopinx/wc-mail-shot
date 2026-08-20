// WooCommerce order.created webhook → IMAP 读取订单邮件 → 截图 → 推送企业微信
// 只处理未读邮件；推送成功后标记已读，避免重复推送
// 推送通道：群机器人 webhook 与自建应用消息可同时启用或任选其一

import { ImapClient } from './imap.js';
import {
  sendImageToGroup,
  sendTextToGroup,
  getAccessToken,
  uploadImage,
  sendAppImage,
} from './wecom.js';
import { parseEml } from './eml.js';
import { screenshotEmail } from './screenshot.js';
import {
  splitList, bytesToText, json, log, setLogLevel,
  retryWithBackoff, createSerialQueue,
} from './utils.js';

const MAX_PER_REQUEST = 8;
const MAX_MATCH_SCAN = 30;

export default {
  async fetch(request, env) {
    setLogLevel(env.LOG_LEVEL || 'error');
    try {
      return await handle(request, env);
    } catch (err) {
      log('error', '请求处理失败', { error: err.message });
      return json({ ok: false, error: err.message }, 502);
    }
  },
};

async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/screenshot-email') {
    return json({ error: 'use POST /screenshot-email' }, 404);
  }
  if (!authorized(request, env)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const payload = await request.json().catch(() => ({}));
  const manualUid = Number(payload.uid || payload.mail_id) || 0;
  const orderNumber = String(payload.number || payload.id || '');
  if (!manualUid && !orderNumber) {
    return json({ ok: false, error: '请求体需包含订单号（id/number）或邮件 uid' }, 400);
  }

  const channels = buildChannels(env, payload);
  if (!channels.length) {
    return json({ ok: false, error: '未配置推送通道' }, 500);
  }

  const filters = {
    from: splitList(payload.mail_from_filter ?? env.MAIL_FROM_FILTER),
    subjectPrefix: splitList(payload.mail_subject_prefix ?? env.MAIL_SUBJECT_PREFIX),
  };

  const retryOpts = { maxRetries: Number(env.RETRY_COUNT || 2), baseDelayMs: 1000 };

  // 自建应用通道启用时才获取 token
  const appToken = channels.some((c) => c.type === 'app')
    ? await getAccessToken(env.WECOM_CORP_ID, env.WECOM_CORP_SECRET)
    : null;

  // IMAP 命令串行队列：避免并发 markSeen 破坏协议
  const imapQueue = createSerialQueue();
  const ctx = { channels, appToken, env, retryOpts, imapQueue };

  const imap = new ImapClient({ host: env.IMAP_HOST, port: Number(env.IMAP_PORT || 993) });
  try {
    await imap.connect();
    await imap.login(env.IMAP_USER, env.IMAP_PASSWORD);
    await imap.select('INBOX');
    return manualUid
      ? await handleManual(imap, manualUid, filters, ctx)
      : await handleAuto(imap, env, orderNumber, filters, ctx);
  } finally {
    imap.destroy();
  }
}

// ---------- 通道构建 ----------

function buildChannels(env, payload) {
  const list = [];
  if (env.WEBHOOK_KEY) {
    list.push({
      type: 'webhook',
      key: env.WEBHOOK_KEY,
      mentioned: splitList(payload.mentioned_list ?? env.MENTIONED_LIST),
      mentionedMobile: splitList(payload.mentioned_mobile_list ?? env.MENTIONED_MOBILE_LIST),
    });
  }
  if (env.WECOM_CORP_ID && env.WECOM_AGENT_ID) {
    list.push({
      type: 'app',
      agentId: Number(env.WECOM_AGENT_ID),
      touser: String(payload.app_touser || env.WECOM_TOUSER || '@all'),
    });
  }
  return list;
}

// ---------- 手动模式 ----------

async function handleManual(imap, uid, filters, ctx) {
  log('info', '手动模式', { uid });
  const emlBytes = await imap.fetchMessage(uid);
  if (!emlBytes) return json({ ok: false, error: `未找到 uid=${uid} 的邮件` }, 404);
  const meta = parseEml(bytesToText(emlBytes));
  if (!passMailFilter(meta, filters)) {
    return json({ ok: false, error: '邮件不满足过滤条件', uid }, 422);
  }
  const bytes = await processEmail(ctx, meta);
  await ctx.imapQueue(() => imap.markSeen(uid));
  log('info', '手动模式完成', { uid, bytes });
  return json({ ok: true, uid, order: null, bytes });
}

// ---------- 自动模式 ----------

async function handleAuto(imap, env, orderNumber, filters, ctx) {
  const maxConcurrent = Number(env.MAX_CONCURRENT_EMAILS || 3);
  log('info', '自动模式', { orderNumber, maxConcurrent });

  // 串行读取未读邮件并筛选（IMAP 连接不能并发读取）
  const uids = (await imap.searchUnread()).slice(-MAX_MATCH_SCAN);
  if (!uids.length) return json({ ok: false, error: '没有未读邮件' }, 404);

  const candidates = [];
  for (const uid of uids) {
    const emlBytes = await imap.fetchMessage(uid);
    if (!emlBytes) continue;
    const meta = parseEml(bytesToText(emlBytes));
    if (!passMailFilter(meta, filters) || !matchesOrder(meta.subject, orderNumber)) continue;
    candidates.push({ uid, meta });
    if (candidates.length >= MAX_PER_REQUEST) break;
  }
  if (!candidates.length) {
    return json({ ok: false, error: `未找到订单 #${orderNumber} 对应的未读邮件` }, 404);
  }
  log('info', `匹配 ${candidates.length} 封，开始并发截图+推送`);

  // 并发截图+推送（不涉及 IMAP），标记已读通过串行队列排队
  const chunks = chunkArray(candidates, maxConcurrent);
  const results = [];
  for (const chunk of chunks) {
    const settled = await Promise.allSettled(
      chunk.map(({ uid, meta }) => processAndMark(imap, uid, meta, ctx))
    );
    for (let i = 0; i < settled.length; i++) {
      if (settled[i].status === 'fulfilled') {
        results.push({ uid: chunk[i].uid, ...settled[i].value });
      } else {
        log('error', `邮件处理失败 uid=${chunk[i].uid}`, { error: settled[i].reason?.message });
      }
    }
  }
  log('info', '自动模式完成', { total: results.length });
  return json({ ok: true, order: orderNumber, count: results.length, processed: results });
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------- 截图 + 推送 + 标记已读 ----------

async function processAndMark(imap, uid, meta, ctx) {
  const bytes = await processEmail(ctx, meta);
  // markSeen 必须串行执行（共享 IMAP 连接），通过队列排队
  await ctx.imapQueue(() => imap.markSeen(uid));
  log('debug', '邮件已标记已读', { uid, subject: meta.subject });
  return { subject: meta.subject, bytes };
}

async function processEmail(ctx, meta) {
  const png = await screenshotEmail(ctx.env, meta);
  log('debug', '截图完成', { bytes: png.byteLength });
  for (const channel of ctx.channels) {
    if (channel.type === 'webhook') {
      await deliverViaWebhook(channel, png, meta, ctx.retryOpts);
    } else {
      await deliverViaApp(ctx, channel, png);
    }
  }
  return png.byteLength;
}

async function deliverViaWebhook(channel, png, meta, retryOpts) {
  await retryWithBackoff(() => sendImageToGroup(channel.key, png), retryOpts);
  if (channel.mentioned.length || channel.mentionedMobile.length) {
    await retryWithBackoff(
      () => sendTextToGroup(channel.key, `📧 新订单邮件通知：${meta.subject}`, channel.mentioned, channel.mentionedMobile),
      retryOpts,
    );
  }
  log('debug', 'Webhook 推送成功');
}

async function deliverViaApp(ctx, channel, png) {
  const mediaId = await retryWithBackoff(() => uploadImage(ctx.appToken, png), ctx.retryOpts);
  await retryWithBackoff(
    () => sendAppImage(ctx.appToken, channel.agentId, mediaId, channel.touser),
    ctx.retryOpts,
  );
  log('debug', '应用消息推送成功');
}

// ---------- 鉴权与过滤 ----------

function authorized(request, env) {
  if (!env.AUTH_TOKEN) return true;
  const headerSecret = request.headers.get('x-wc-webhook-secret') || '';
  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return headerSecret === env.AUTH_TOKEN || bearer === env.AUTH_TOKEN;
}

function passMailFilter(meta, filters) {
  if (filters.from.length && !filters.from.some((f) => matchFrom(meta.from, f))) return false;
  if (filters.subjectPrefix.length && !filters.subjectPrefix.some((p) => meta.subject.startsWith(p))) {
    return false;
  }
  return true;
}

function matchFrom(fromHeader, filter) {
  const m = /<([^>]+)>/.exec(fromHeader || '');
  const address = (m ? m[1] : fromHeader || '').trim().toLowerCase();
  return address.endsWith(filter.trim().toLowerCase());
}

function matchesOrder(subject, orderNumber) {
  if (!subject || !orderNumber) return false;
  return subject.includes(`#${orderNumber}`) || subject.includes(orderNumber);
}