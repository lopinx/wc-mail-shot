// EML 解析器断言测试：node test/eml.test.js
import assert from 'node:assert';
import { parseEml } from '../src/eml.js';

// 1. multipart/alternative：base64 中文主题 + base64 HTML 正文
const eml1 = [
  'Subject: =?utf-8?B?V29vQ29tbWVyY2Ug6K6i5Y2V6YCa55+lICMxMjM0?=',
  'From: WooCommerce <woocommerce@example.com>',
  'Date: Wed, 20 Aug 2026 10:00:00 +0800',
  'Content-Type: multipart/alternative; boundary="BOUNDARY1"',
  '',
  '--BOUNDARY1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  '纯文本正文',
  '--BOUNDARY1',
  'Content-Type: text/html; charset=utf-8',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('<h1>订单 #1234</h1><p>合计：¥299.00</p>').toString('base64'),
  '--BOUNDARY1--',
  '',
].join('\r\n');
const r1 = parseEml(eml1);
assert.equal(r1.subject, 'WooCommerce 订单通知 #1234');
assert.ok(r1.html.includes('订单 #1234'), 'html 正文应包含订单号');
assert.equal(r1.text, '纯文本正文');
console.log('case1 multipart/base64 OK');

// 2. quoted-printable 编码的单 part HTML
const eml2 = [
  'Subject: Order #5678',
  'From: shop@example.com',
  'Content-Type: text/html; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<p>=E6=80=BB=E8=AE=A1=EF=BC=9A=C2=A5100.00</p>',
  '',
].join('\r\n');
const r2 = parseEml(eml2);
assert.ok(r2.html.includes('总计：¥100.00'), 'QP 中文应正确解码');
console.log('case2 quoted-printable OK');

// 3. 纯文本邮件（无 HTML 正文，末尾 EOF 换行应被去掉）
const eml3 = [
  'Subject: Plain mail',
  'From: a@b.c',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'hello world',
  '',
].join('\n');
const r3 = parseEml(eml3);
assert.equal(r3.html, '');
assert.equal(r3.text, 'hello world');
console.log('case3 plain text OK');

// 4. 嵌套 multipart（mixed 内嵌 alternative，含附件 part）
const eml4 = [
  'Subject: Nested #9',
  'Content-Type: multipart/mixed; boundary="OUTER"',
  '',
  '--OUTER',
  'Content-Type: multipart/alternative; boundary="INNER"',
  '',
  '--INNER',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'fallback text',
  '--INNER',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<b>inner html</b>',
  '--INNER--',
  '--OUTER',
  'Content-Type: image/png; name="logo.png"',
  'Content-Transfer-Encoding: base64',
  '',
  'iVBORw0KGgo=',
  '--OUTER--',
  '',
].join('\r\n');
const r4 = parseEml(eml4);
assert.ok(r4.html.includes('inner html'));
assert.equal(r4.text, 'fallback text');
console.log('case4 nested multipart OK');

// 5. 头部折叠与 Q 编码主题
const eml5 = [
  'Subject: =?utf-8?Q?Order_=23100?=',
  'X-Long: first',
  ' second',
  'Content-Type: text/plain',
  '',
  'body',
].join('\r\n');
const r5 = parseEml(eml5);
assert.equal(r5.subject, 'Order #100');
assert.equal(r5.text, 'body');
console.log('case5 folded header + Q-encoding OK');

console.log('ALL_EML_TESTS_PASSED');