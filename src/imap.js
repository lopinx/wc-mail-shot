// 极简 IMAP4rev1 客户端（RFC 3501）：仅覆盖本项目所需命令
// LOGIN / SELECT / SEARCH / FETCH / STORE / LOGOUT
// 用 Workers 官方 cloudflare:sockets 建立 IMAPS（993，TLS）连接。
// 协议为标签式请求-响应，同一连接上的命令必须串行执行；
// 读取基于字节缓冲，保证 FETCH literal（邮件原文）按 {N} 声明长度精确截取。

import { connect } from 'cloudflare:sockets';

const encoder = new TextEncoder();

export class ImapClient {
  constructor({ host, port = 993, timeoutMs = 30000 }) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.reader = null;
    this.writer = null;
    this.buffer = new Uint8Array(0);
    this.dataWaiters = [];
    this.tagSeq = 0;
    this.failed = null;
  }

  // 建立 IMAPS 连接并确认服务器问候
  async connect() {
    this.socket = connect(`${this.host}:${this.port}`, { secureTransport: 'on' });
    this.writer = this.socket.writable.getWriter();
    this.reader = this.socket.readable.getReader();
    this.pump();
    const greeting = await this.readLine();
    if (!greeting.startsWith('* OK')) {
      throw new Error(`IMAP 服务器拒绝连接：${greeting}`);
    }
  }

  // 后台持续读取 socket 数据进缓冲；连接结束或出错时置为失败态
  pump() {
    const loop = async () => {
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) this.onData(value);
        }
        this.fail(new Error('IMAP 连接已关闭'));
      } catch (err) {
        this.fail(err);
      }
    };
    loop();
  }

  onData(chunk) {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    for (const waiter of this.dataWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  async write(text) {
    this.ensureAlive();
    await this.writer.write(encoder.encode(text));
  }

  // 等待 predicate 成立；期间每来一段数据重试一次，超时抛错
  async waitFor(predicate, timeoutMs = this.timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.ensureAlive();
      if (predicate()) return;
      const remain = deadline - Date.now();
      if (remain <= 0) throw new Error('IMAP 响应超时');
      await new Promise((resolve, reject) => {
        const entry = { resolve };
        entry.timer = setTimeout(() => {
          const i = this.dataWaiters.indexOf(entry);
          if (i >= 0) this.dataWaiters.splice(i, 1);
          reject(new Error('IMAP 响应超时'));
        }, remain);
        this.dataWaiters.push(entry);
      });
    }
  }

  async readLine(timeoutMs = this.timeoutMs) {
    await this.waitFor(() => this.buffer.includes(10), timeoutMs);
    const idx = this.buffer.indexOf(10);
    let end = idx;
    if (end > 0 && this.buffer[end - 1] === 13) end -= 1;
    const line = new TextDecoder('utf-8').decode(this.buffer.subarray(0, end));
    this.buffer = this.buffer.subarray(idx + 1);
    return line;
  }

  async readBytes(n, timeoutMs = this.timeoutMs) {
    await this.waitFor(() => this.buffer.length >= n, timeoutMs);
    const bytes = this.buffer.slice(0, n);
    this.buffer = this.buffer.subarray(n);
    return bytes;
  }

  async login(user, password) {
    await this.command(`LOGIN ${quote(user)} ${quote(password)}`);
  }

  async select(mailbox = 'INBOX') {
    await this.command(`SELECT ${quote(mailbox)}`);
  }

  // 未读邮件 UID 列表（升序）
  async searchUnread() {
    const resp = await this.command('UID SEARCH UNSEEN');
    for (const line of resp.data) {
      const m = /^\* SEARCH(?:\s+(.+))?$/i.exec(line);
      if (!m) continue;
      return m[1] ? m[1].trim().split(/\s+/).map(Number).filter((n) => n > 0) : [];
    }
    return [];
  }

  // 按 UID 取邮件原文；邮件不存在返回 null
  async fetchMessage(uid) {
    const tag = await this.send(`UID FETCH ${uid} (BODY.PEEK[])`);
    let eml = null;
    for (;;) {
      const { line, literal } = await this.readResponseLine();
      if (line.startsWith(tag + ' ')) {
        if (!/^OK/i.test(line.slice(tag.length + 1))) throw new Error(`FETCH ${uid} 失败：${line}`);
        return eml;
      }
      if (/^\* \d+ FETCH\b/i.test(line) && literal !== null) eml = literal;
    }
  }

  // 标记已读（.SILENT 不回传更新后的 FLAGS，简化响应处理）
  async markSeen(uid) {
    await this.command(`UID STORE ${uid} +FLAGS.SILENT (\\Seen)`);
  }

  async logout() {
    try {
      await this.command('LOGOUT');
    } catch {
      // 连接可能已断开，忽略
    }
    this.destroy();
  }

  destroy() {
    try {
      this.socket?.close();
    } catch {
      // 已关闭则忽略
    }
  }

  // ---------- 内部实现 ----------

  // 发送命令并等待同标签响应，返回 { status, data }
  async command(text) {
    const tag = await this.send(text);
    return this.waitTagged(tag);
  }

  async send(text) {
    const tag = `Z${++this.tagSeq}`;
    await this.write(`${tag} ${text}\r\n`);
    return tag;
  }

  async waitTagged(tag) {
    const data = [];
    for (;;) {
      const line = await this.readLine();
      if (line.startsWith(tag + ' ')) {
        const rest = line.slice(tag.length + 1);
        const status = rest.split(' ')[0].toUpperCase();
        if (status !== 'OK') throw new Error(`IMAP 命令失败：${line}`);
        return { status, data };
      }
      if (line.startsWith('* ')) data.push(line);
    }
  }

  // 读取一行；若行尾为 {N} literal 标记则同时读出 N 字节原文
  async readResponseLine() {
    const line = await this.readLine();
    const m = /\{(\d+)\}$/.exec(line);
    if (m && /^\* \d+ FETCH\b/i.test(line)) {
      const literal = await this.readBytes(Number(m[1]));
      const rest = await this.readLine();
      return { line: line + rest, literal };
    }
    return { line, literal: null };
  }

  ensureAlive() {
    if (this.failed) throw this.failed;
  }

  fail(err) {
    if (this.failed) return;
    this.failed = err;
    for (const waiter of this.dataWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }
}

// IMAP quoted string 转义（RFC 3501 §4.3）
function quote(str) {
  return '"' + String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}