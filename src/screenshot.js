// 邮件内容渲染与截图：支持 Browser Rendering 和第三方截图 API
// 通过环境变量 SCREENSHOT_MODE 切换：'browser' 或 'api'
// 第三方 API 支持多个 key 轮询，故障自动转移

import { retryWithBackoff, log } from './utils.js';

const PAGE_WIDTH = 800;
const MAX_HEIGHT = 6000;
const WEBHOOK_SIZE_LIMIT = 2 * 1024 * 1024;

// 把邮件正文包装为完整页面，注入基础样式保证可读性
function wrapHtml(bodyHtml, meta) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; background: #f2f3f5; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
  .mail-meta { padding: 16px 24px; background: #ffffff; border-bottom: 1px solid #e5e6eb; }
  .mail-meta .subject { font-size: 20px; font-weight: 600; color: #1d2129; margin-bottom: 8px; }
  .mail-meta .line { font-size: 13px; color: #86909c; margin-top: 4px; word-break: break-all; }
  .mail-body { padding: 24px; background: #ffffff; }
  .mail-body img { max-width: 100% !important; height: auto !important; }
  .mail-body table { max-width: 100% !important; }
  .mail-body .plain { white-space: pre-wrap; word-break: break-all; font-family: inherit; margin: 0; }
</style>
</head>
<body>
  <div class="mail-meta">
    <div class="subject">${escapeHtml(meta.subject) || '(无主题)'}</div>
    <div class="line">发件人：${escapeHtml(meta.from)}</div>
    <div class="line">时间：${escapeHtml(meta.date)}</div>
  </div>
  <div class="mail-body">${bodyHtml}</div>
</body>
</html>`;
}

function escapeHtml(str) {
  return (str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function buildBodyHtml(meta) {
  return meta.html || `<pre class="plain">${escapeHtml(meta.text || '(无正文)')}</pre>`;
}

// 截图入口：根据 SCREENSHOT_MODE 选择实现
export async function screenshotEmail(env, meta) {
  const mode = env.SCREENSHOT_MODE || 'browser';
  const retryOpts = { maxRetries: Number(env.RETRY_COUNT || 2), baseDelayMs: 1000 };
  log('info', `截图模式: ${mode}`);
  if (mode === 'browser') {
    return retryWithBackoff(() => screenshotWithBrowser(env.BROWSER, meta), retryOpts);
  }
  if (mode === 'api') {
    return retryWithBackoff(() => screenshotWithApi(env, meta), retryOpts);
  }
  throw new Error(`未知的截图模式: ${mode}`);
}

// ---------- Browser Rendering ----------

async function screenshotWithBrowser(browser, meta) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: PAGE_WIDTH, height: 800, deviceScaleFactor: 2 });
    await page.setContent(wrapHtml(buildBodyHtml(meta), meta), {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });
    const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
    const clipHeight = Math.min(Math.max(bodyHeight, 400), MAX_HEIGHT);
    const clip = { x: 0, y: 0, width: PAGE_WIDTH, height: clipHeight };

    let png = await page.screenshot({ type: 'png', clip });
    if (png.byteLength > WEBHOOK_SIZE_LIMIT) {
      await page.setViewport({ width: PAGE_WIDTH, height: 800, deviceScaleFactor: 1 });
      png = await page.screenshot({ type: 'png', clip });
    }
    log('debug', 'Browser 截图完成', { bytes: png.byteLength });
    return new Uint8Array(png);
  } finally {
    await page.close();
  }
}

// ---------- 第三方截图 API（多 key 轮询 + 故障转移） ----------

async function screenshotWithApi(env, meta) {
  if (!env.SCREENSHOT_API_URL) throw new Error('未配置 SCREENSHOT_API_URL');
  const keys = (env.SCREENSHOT_API_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!keys.length) throw new Error('未配置 SCREENSHOT_API_KEYS');

  const fullHtml = wrapHtml(buildBodyHtml(meta), meta);
  const encodedHtml = encodeURIComponent(fullHtml);

  let lastError;
  for (const key of keys) {
    const url = env.SCREENSHOT_API_URL
      .replace(/\{key\}/g, key)
      .replace(/\{html\}/g, encodedHtml);

    try {
      log('debug', `尝试截图 API key: ${key.slice(0, 6)}...`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      let resp;
      try {
        resp = await fetch(url, {
          method: 'GET',
          headers: { Accept: 'image/png' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) throw new Error(`API 返回 ${resp.status} ${resp.statusText}`);
      const png = new Uint8Array(await resp.arrayBuffer());
      log('info', '截图 API 成功', { key: key.slice(0, 6), bytes: png.byteLength });
      return png;
    } catch (err) {
      lastError = err;
      log('warn', `截图 API key 失败: ${key.slice(0, 6)}...`, err.message);
      // 继续尝试下一个 key
    }
  }
  throw new Error(`所有截图 API key 均失败: ${lastError?.message || '未知错误'}`);
}