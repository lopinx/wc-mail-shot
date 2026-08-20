// 通用工具函数：日志、重试、列表解析、响应封装等

// ---------- 日志系统 ----------
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
let currentLevel = 'error';

export function setLogLevel(level) {
  if (level && level in LOG_LEVELS) currentLevel = level;
}

export function log(level, message, data = null) {
  if (LOG_LEVELS[level] > LOG_LEVELS[currentLevel]) return;
  const prefix = `[${level.toUpperCase()}]`;
  const fn = level === 'error' ? console.error : console.log;
  if (data !== null) fn(prefix, message, typeof data === 'string' ? data : JSON.stringify(data));
  else fn(prefix, message);
}

// ---------- 重试机制（指数退避） ----------
// options: { maxRetries=2, baseDelayMs=1000, backoffFactor=2, onRetry=null }
export async function retryWithBackoff(fn, options = {}) {
  const {
    maxRetries = 2,
    baseDelayMs = 1000,
    backoffFactor = 2,
    onRetry = null,
  } = options;

  let lastError;
  let delay = baseDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) log('info', `重试成功（第 ${attempt} 次尝试）`);
      return result;
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) break;
      if (onRetry) onRetry(err, attempt + 1, delay);
      log('warn', `第 ${attempt + 1} 次失败，${delay}ms 后重试`, err.message);
      await sleep(delay);
      delay *= backoffFactor;
    }
  }
  throw lastError;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- 工具函数 ----------
export function splitList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function bytesToText(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// 将 markSeen 等需要串行执行的 IMAP 命令排队，避免并发破坏协议
export function createSerialQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(() => task());
    // 即使 task 失败也不阻塞后续排队
    tail = run.catch(() => {});
    return run;
  };
}
