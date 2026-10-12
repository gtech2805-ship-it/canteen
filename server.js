'use strict';
// Canteen ordering server. No packages to install: it uses only what comes with Node.js (version 18 or newer).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- configuration (.env file or real environment variables) ----------
(function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* no .env file: fine on a host */ }
})();

const PORT = Number(process.env.PORT || 3000);
const STAFF_PIN = String(process.env.STAFF_PIN || '');
const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const MOCK = process.env.PAYMENT_MODE === 'mock';
const PARCEL_FEE = Number(process.env.PARCEL_FEE || 5);
const PENDING_MIN = Number(process.env.PENDING_MINUTES || 15);
const CLEANUP_MS = Number(process.env.CLEANUP_MS || 60000);
const KEEP_DAYS = 60;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'canteen.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (STAFF_PIN.length < 4) {
  console.error('Please set STAFF_PIN (at least 4 characters) in your environment or .env file.');
  process.exit(1);
}
const SIGN_SECRET = MOCK ? (KEY_SECRET || 'mock_secret') : KEY_SECRET;
const HOOK_SECRET = MOCK ? (WEBHOOK_SECRET || 'mock_webhook') : WEBHOOK_SECRET;
const ONLINE = MOCK || Boolean(KEY_ID && KEY_SECRET);

// ---------- storage: one JSON file, written safely after every change ----------
let data = { menu: [], orders: [], banner: '' };
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
try {
  const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  data = { menu: j.menu || [], orders: j.orders || [], banner: j.banner || '' };
} catch (e) {
  if (e.code !== 'ENOENT') { console.error('Could not read ' + DATA_FILE + ': ' + e.message); process.exit(1); }
}
function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, DATA_FILE);
}
(function prune() {
  const cutoff = Date.now() - KEEP_DAYS * 86400000, before = data.orders.length;
  data.orders = data.orders.filter(o => o.created >= cutoff || o.refund);
  if (data.orders.length !== before) save();
})();

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const eff = m => (m.disc ? Math.round(m.price * (1 - m.disc / 100)) : m.price);
const isAvail = m => !!m.avail && (m.qty === null || m.qty > 0);
const menuOut = m => ({ id: m.id, name: m.name, cat: m.cat, price: m.price, disc: m.disc, eff: eff(m), avail: isAvail(m), qty: m.qty });
const hmac = (secret, d) => crypto.createHmac('sha256', secret).update(d).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const orderOut = o => ({
  id: o.id, token: o.token, day: o.day, created: o.created, name: o.name, type: o.type, fee: o.fee,
  total: o.total, pay: o.pay, paid: o.paid, status: o.status, refund: o.refund,
  items: o.items, rpOrder: o.status === 'PendingPayment' ? o.rp_order : undefined
});
const getOrder = id => data.orders.find(o => o.id === id);
const getItem = id => data.menu.find(m => m.id === id);
const nextToken = day => data.orders.reduce((mx, o) => (o.day === day && o.token ? Math.max(mx, o.token) : mx), 0) + 1;
const restoreStock = items => { for (const i of items) { const m = getItem(i.id); if (m && m.qty !== null) m.qty += i.q; } };

// simple in-memory rate limiter
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600000)) hits.delete(k); }, 600000).unref();

// ---------- order logic ----------
function createOrder(name, type, pay, want) {
  const items = []; let sum = 0;
  for (const [id, q] of want) {          // check everything first, change nothing until all is valid
    const m = getItem(id);
    if (!m || !isAvail(m)) throw new HttpError(409, (m ? m.name : 'An item') + ' is sold out.');
    if (m.qty !== null && m.qty < q) throw new HttpError(409, 'Only ' + m.qty + ' ' + m.name + ' left.');
    items.push({ id, n: m.name, q, p: eff(m) });
    sum += eff(m) * q;
  }
  for (const i of items) { const m = getItem(i.id); if (m.qty !== null) m.qty -= i.q; }
  const fee = type === 'Parcel' ? PARCEL_FEE : 0, day = today();
  const o = {
    id: crypto.randomUUID(), token: null, day, created: Date.now(), name, type, fee, total: sum + fee, pay,
    paid: false, status: 'PendingPayment', rp_order: null, rp_payment: '', refund: false, items
  };
  if (pay === 'COD') { o.token = nextToken(day); o.status = 'Preparing'; }
  data.orders.push(o); save();
  return o;
}

// Give back the stock of an unpaid order (cancel, failed start, or timeout)
function releaseOrder(o, newStatus) {
  if (!o || o.status !== 'PendingPayment') return false;
  restoreStock(o.items); o.status = newStatus; save();
  return true;
}

// Only called after a payment is PROVEN (valid signature or valid webhook). Safe to call twice.
function finalizePaid(o, paymentId) {
  if (o.status === 'PendingPayment' || o.status === 'Expired') {
    if (o.status === 'Expired') {          // stock was given back earlier: try to take it again
      const ok = o.items.every(i => { const m = getItem(i.id); return m && (m.qty === null || m.qty >= i.q); });
      if (!ok) { Object.assign(o, { status: 'Cancelled', refund: true, paid: true, rp_payment: paymentId }); save(); return o; }
      for (const i of o.items) { const m = getItem(i.id); if (m.qty !== null) m.qty -= i.q; }
    }
    const day = today();
    Object.assign(o, { status: 'Preparing', paid: true, token: nextToken(day), day, rp_payment: paymentId });
    save();
  } else if (o.status === 'Cancelled' && !o.paid) {   // student cancelled but money still arrived
    Object.assign(o, { refund: true, paid: true, rp_payment: paymentId }); save();
  }
  return o;
}

async function rpCreateOrder(amountPaise, receipt) {
  if (MOCK) return { id: 'order_mock_' + crypto.randomBytes(6).toString('hex') };
  const r = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(KEY_ID + ':' + KEY_SECRET).toString('base64') },
    body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt: String(receipt).slice(0, 40), payment_capture: 1 })
  });
  if (!r.ok) throw new Error('Razorpay order failed: ' + r.status);
  return r.json();
}

// Unpaid online orders give their stock back after PENDING_MINUTES
setInterval(() => {
  try {
    const cutoff = Date.now() - PENDING_MIN * 60000;
    for (const o of data.orders) if (o.status === 'PendingPayment' && o.created < cutoff) releaseOrder(o, 'Expired');
  } catch (e) { console.error('cleanup error', e); }
}, CLEANUP_MS).unref();

// ---------- tiny router ----------
const routes = [];
const route = (method, pattern, handler, opts) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:[a-z]+/g, '([^/]+)') + '$'), handler, ...(opts || {}) });
const clientIp = req => { // behind a host's proxy the last address is the real visitor
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress;
};
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

// ---------- public API ----------
route('GET', '/api/public', () => {
  const t = today();
  const menu = [...data.menu].sort((a, b) => a.cat.localeCompare(b.cat) || a.created - b.created).map(menuOut);
  const queue = data.orders.filter(o => o.day === t && o.token && ['Preparing', 'Prepared'].includes(o.status))
    .sort((a, b) => a.token - b.token).map(o => ({ token: o.token, status: o.status, type: o.type, items: o.items.map(i => ({ n: i.n, q: i.q })) }));
  return { menu, queue, banner: data.banner, onlineEnabled: ONLINE, keyId: MOCK ? (KEY_ID || 'rzp_mock') : KEY_ID, mock: MOCK, parcelFee: PARCEL_FEE };
});

route('POST', '/api/orders', async ({ body: b, ip }) => {
  if (limited('order:' + ip, 20, 600000)) throw new HttpError(429, 'Too many orders. Please wait a few minutes.');
  const name = String(b.name || '').trim().slice(0, 40);
  if (!name) throw new HttpError(400, 'Please enter your name.');
  if (!['Dine in', 'Parcel'].includes(b.type)) throw new HttpError(400, 'Choose dine in or parcel.');
  if (!['ONLINE', 'COD'].includes(b.pay)) throw new HttpError(400, 'Choose a payment method.');
  if (b.pay === 'ONLINE' && !ONLINE) throw new HttpError(400, 'Online payment is not available. Please choose pay at counter.');
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 30) throw new HttpError(400, 'Your order is empty.');
  const want = new Map();
  for (const it of b.items) {
    if (!it || typeof it.id !== 'string' || !Number.isInteger(it.q) || it.q < 1 || it.q > 20) throw new HttpError(400, 'Invalid item in order.');
    want.set(it.id, Math.min(20, (want.get(it.id) || 0) + it.q));
  }
  const o = createOrder(name, b.type, b.pay, want);   // the price always comes from the server, never from the browser
  if (b.pay === 'ONLINE') {
    try {
      const rp = await rpCreateOrder(o.total * 100, o.id);
      o.rp_order = rp.id; save();
    } catch (e) {
      releaseOrder(o, 'Cancelled');
      console.error(e);
      throw new HttpError(502, 'Could not start the payment. Please try again.');
    }
  }
  return { order: orderOut(o), keyId: MOCK ? (KEY_ID || 'rzp_mock') : KEY_ID, amount: o.total * 100, mock: MOCK };
});

route('GET', '/api/orders', ({ query }) => {
  const ids = String(query.get('ids') || '').split(',').filter(Boolean).slice(0, 30);
  return { orders: ids.map(getOrder).filter(Boolean).map(orderOut) };
});

route('POST', '/api/orders/:id/verify', ({ params, body, ip }) => {
  if (limited('verify:' + ip, 30, 600000)) throw new HttpError(429, 'Too many attempts.');
  const o = getOrder(params[0]);
  if (!o || !o.rp_order) throw new HttpError(404, 'Order not found.');
  const pid = body.razorpay_payment_id, sig = body.razorpay_signature;
  if (!pid || !sig || !safeEq(hmac(SIGN_SECRET, o.rp_order + '|' + pid), sig)) throw new HttpError(400, 'Payment could not be verified.');
  return { order: orderOut(finalizePaid(o, String(pid))) };
});

route('POST', '/api/orders/:id/cancel', ({ params }) => {
  const o = getOrder(params[0]);
  if (!o) throw new HttpError(404, 'Order not found.');
  if (o.status !== 'PendingPayment') throw new HttpError(409, 'This order can no longer be cancelled here.');
  releaseOrder(o, 'Cancelled');
  return { order: orderOut(o) };
});

// Razorpay tells us a payment succeeded (backup for when the customer closes the page right after paying)
route('POST', '/api/razorpay/webhook', ({ raw, req }) => {
  if (!HOOK_SECRET) throw new HttpError(503, 'Webhook secret not configured.');
  if (!safeEq(hmac(HOOK_SECRET, raw), req.headers['x-razorpay-signature'])) throw new HttpError(400, 'Bad signature.');
  let ev; try { ev = JSON.parse(raw.toString('utf8')); } catch (e) { throw new HttpError(400, 'Bad JSON.'); }
  if (ev.event === 'payment.captured' || ev.event === 'order.paid') {
    const pay = ev.payload && ev.payload.payment && ev.payload.payment.entity;
    if (pay && pay.order_id) {
      const o = data.orders.find(x => x.rp_order === pay.order_id);
      if (o && pay.amount === o.total * 100 && pay.status === 'captured') finalizePaid(o, pay.id);
    }
  }
  return { ok: true };
}, { raw: true });

// Local testing only: makes a valid signature so the whole flow can be tried without Razorpay.
if (MOCK) {
  route('POST', '/api/dev/pay/:id', ({ params }) => {
    const o = getOrder(params[0]);
    if (!o || !o.rp_order) throw new HttpError(404, 'Order not found.');
    const pid = 'pay_mock_' + crypto.randomBytes(5).toString('hex');
    return { razorpay_payment_id: pid, razorpay_order_id: o.rp_order, razorpay_signature: hmac(SIGN_SECRET, o.rp_order + '|' + pid) };
  });
}

// ---------- staff API ----------
const sessions = new Map();
const hashPin = s => crypto.createHash('sha256').update(String(s)).digest();
route('POST', '/api/staff/login', ({ body, ip }) => {
  const key = 'login:' + ip;
  if (limited(key, 6, 600000)) throw new HttpError(429, 'Too many wrong PINs. Try again in 10 minutes.');
  if (!crypto.timingSafeEqual(hashPin(body.pin || ''), hashPin(STAFF_PIN))) throw new HttpError(401, 'Wrong PIN.');
  hits.delete(key);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + 12 * 3600000);
  return { token };
});
function requireStaff(req) {
  const t = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const exp = sessions.get(t);
  if (!exp || exp < Date.now()) { sessions.delete(t); throw new HttpError(401, 'Please sign in again.'); }
}
const A = { auth: true };

route('GET', '/api/staff/orders', () => {
  const t = today();
  const rows = data.orders.filter(o => (o.day === t && !['PendingPayment', 'Expired'].includes(o.status)) || o.refund).sort((a, b) => a.created - b.created);
  return { orders: rows.map(o => ({ ...orderOut(o), paymentId: o.rp_payment || '' })) };
}, A);

route('POST', '/api/staff/orders/:id/status', ({ params, body }) => {
  const o = getOrder(params[0]);
  if (!o) throw new HttpError(404, 'Order not found.');
  if ({ Preparing: 'Prepared', Prepared: 'Delivered' }[o.status] !== body.status) throw new HttpError(409, 'That change is not allowed.');
  if (body.status === 'Delivered' && o.pay === 'COD') o.paid = true;   // cash is collected when the order is handed over
  o.status = body.status; save();
  return { order: orderOut(o) };
}, A);

route('POST', '/api/staff/orders/:id/cancel', ({ params }) => {
  const o = getOrder(params[0]);
  if (!o) throw new HttpError(404, 'Order not found.');
  if (!['Preparing', 'Prepared'].includes(o.status)) throw new HttpError(409, 'Only orders in the queue can be cancelled.');
  restoreStock(o.items);
  o.status = 'Cancelled'; o.refund = o.pay === 'ONLINE' && o.paid; save();
  return { order: orderOut(o) };
}, A);

route('POST', '/api/staff/orders/:id/refunded', ({ params }) => {
  const o = getOrder(params[0]);
  if (o) { o.refund = false; save(); }
  return { ok: true };
}, A);

route('GET', '/api/staff/sales', () => {
  const rows = data.orders.filter(o => o.day === today() && ['Preparing', 'Prepared', 'Delivered'].includes(o.status));
  const cnt = {}; let revenue = 0, online = 0, cod = 0;
  for (const o of rows) {
    revenue += o.total; if (o.pay === 'ONLINE') online += o.total; else cod += o.total;
    for (const i of o.items) cnt[i.n] = (cnt[i.n] || 0) + i.q;
  }
  const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, q]) => ({ n, q }));
  return { revenue, orders: rows.length, online, cod, top };
}, A);

// ----- downloads: every order as a spreadsheet file (CSV opens in Excel / Google Sheets), and a full backup -----
const csvCell = v => {
  let t = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;          // stops a customer name from running as a spreadsheet formula
  return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
};
route('GET', '/api/staff/export', () => {
  const head = ['Date', 'Time', 'Token', 'Name', 'Dine in / Parcel', 'Items', 'Parcel charge', 'Total (INR)', 'Payment', 'Paid', 'Status', 'Razorpay payment id'];
  const rows = [...data.orders].sort((a, b) => a.created - b.created).map(o => [
    o.day, new Date(o.created).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }), o.token || '', o.name, o.type,
    o.items.map(i => i.q + ' x ' + i.n + ' @ ' + i.p).join('; '), o.fee, o.total, o.pay === 'ONLINE' ? 'Online' : 'At counter', o.paid ? 'Yes' : 'No', o.status, o.rp_payment || ''
  ]);
  const csv = '\uFEFF' + [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  return { __file: true, type: 'text/csv; charset=utf-8', name: 'canteen-orders-' + today() + '.csv', body: csv };
}, A);
route('GET', '/api/staff/backup', () => ({ __file: true, type: 'application/json', name: 'canteen-backup-' + today() + '.json', body: JSON.stringify(data, null, 2) }), A);

const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const intIn = (v, min, max) => { const n = Number(v); return v !== '' && v !== null && Number.isInteger(n) && n >= min && n <= max ? n : null; };
const blank = v => v === '' || v === null || v === undefined;

route('POST', '/api/staff/menu', ({ body: b }) => {
  const name = text(b.name, 60), price = intIn(b.price, 1, 100000);
  if (!name || price === null) throw new HttpError(400, 'Enter an item name and a price above 0.');
  const qty = blank(b.qty) ? null : intIn(b.qty, 0, 100000), disc = blank(b.disc) ? 0 : intIn(b.disc, 0, 90);
  if (disc === null || (!blank(b.qty) && qty === null)) throw new HttpError(400, 'Check the quantity and % off values.');
  const m = { id: crypto.randomBytes(6).toString('hex'), name, cat: text(b.cat, 30) || 'Other', price, avail: true, qty, disc, created: Date.now() };
  data.menu.push(m); save();
  return { item: menuOut(m) };
}, A);

route('PATCH', '/api/staff/menu/:id', ({ params, body: b }) => {
  const m = getItem(params[0]);
  if (!m) throw new HttpError(404, 'Item not found.');
  const n = { ...m };
  if ('name' in b) { n.name = text(b.name, 60); if (!n.name) throw new HttpError(400, 'Name cannot be empty.'); }
  if ('cat' in b) n.cat = text(b.cat, 30) || 'Other';
  if ('price' in b) { n.price = intIn(b.price, 1, 100000); if (n.price === null) throw new HttpError(400, 'Invalid price.'); }
  if ('avail' in b) n.avail = !!b.avail;
  if ('qty' in b) { n.qty = blank(b.qty) ? null : intIn(b.qty, 0, 100000); if (!blank(b.qty) && n.qty === null) throw new HttpError(400, 'Invalid quantity.'); }
  if ('disc' in b) { n.disc = blank(b.disc) ? 0 : intIn(b.disc, 0, 90); if (n.disc === null) throw new HttpError(400, 'Offer must be 0 to 90 percent.'); }
  Object.assign(m, n); save();
  return { item: menuOut(m) };
}, A);

route('DELETE', '/api/staff/menu/:id', ({ params }) => {
  data.menu = data.menu.filter(m => m.id !== params[0]); save();
  return { ok: true };
}, A);

route('PUT', '/api/staff/banner', ({ body }) => {
  data.banner = text(body.text, 120); save();
  return { ok: true };
}, A);

// ---------- static files ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      return serveStatic(p, res);
    }
    const r = routes.find(x => x.method === req.method && x.re.test(p));
    if (!r) throw new HttpError(routes.some(x => x.re.test(p)) ? 405 : 404, 'Not found.');
    const params = p.match(r.re).slice(1).map(decodeURIComponent);
    const raw = await readBody(req, r.raw ? 1048576 : 51200);
    let body = {};
    if (!r.raw && raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch (e) { throw new HttpError(400, 'Bad request.'); } }
    if (body === null || typeof body !== 'object') body = {};
    if (r.auth) requireStaff(req);
    const out = await r.handler({ req, res, params, body, raw, query: url.searchParams, ip: clientIp(req) });
    if (out && out.__file) {
      res.writeHead(200, { 'Content-Type': out.type, 'Content-Disposition': 'attachment; filename="' + out.name + '"', 'Cache-Control': 'no-store' });
      return res.end(out.body);
    }
    send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Server error. Please try again.' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log('Canteen app running on port ' + PORT + (MOCK ? ' (MOCK payments: for testing only)' : ONLINE ? ' (Razorpay online payments ON)' : ' (online payments OFF: add Razorpay keys)')));
}
module.exports = server;
