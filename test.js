'use strict';
// Automatic checks of the whole ordering and payment flow, using FAKE payments (no Razorpay needed).
// Run with:  npm test
const { spawn } = require('child_process');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function start(port, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canteen-'));
  const env = { ...process.env, PORT: String(port), PAYMENT_MODE: 'mock', STAFF_PIN: '4321', DATA_FILE: path.join(dir, 'c.json'), ...(extra || {}) };
  const p = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    p.stdout.on('data', d => { if (String(d).includes('running')) resolve({ p, dir, base: 'http://127.0.0.1:' + port }); });
    p.on('exit', c => reject(new Error('server exited ' + c)));
  });
}
const call = (base, tok) => async (method, url, body, raw) => {
  const h = { 'Content-Type': 'application/json' }; if (tok.v) h.Authorization = 'Bearer ' + tok.v;
  const r = await fetch(base + url, { method, headers: h, body: raw !== undefined ? raw : (body ? JSON.stringify(body) : undefined) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAILED: ' + name); passed++; console.log('  ok  ' + name); };

(async () => {
  // ---------- main flow ----------
  const S = await start(3901); const tok = {}; const api = call(S.base, tok);
  try {
    console.log('Staff sign-in');
    ok('wrong PIN is refused', (await api('POST', '/api/staff/login', { pin: '0000' })).status === 401);
    ok('staff routes need sign-in', (await api('GET', '/api/staff/orders')).status === 401);
    tok.v = (await api('POST', '/api/staff/login', { pin: '4321' })).body.token; ok('right PIN signs in', !!tok.v);

    console.log('Menu, stock and offers');
    const dosa = (await api('POST', '/api/staff/menu', { name: 'Dosa', cat: 'Breakfast', price: 40, qty: 3, disc: 25 })).body.item;
    const coffee = (await api('POST', '/api/staff/menu', { name: 'Coffee', cat: 'Drinks', price: 20, qty: '' })).body.item;
    const barotta = (await api('POST', '/api/staff/menu', { name: 'Barotta', cat: 'Breakfast', price: 15, qty: 5 })).body.item;
    ok('bad price is refused', (await api('POST', '/api/staff/menu', { name: 'X', price: 0 })).status === 400);
    let pub = (await api('GET', '/api/public')).body;
    ok('25% off makes 40 become 30', pub.menu.find(m => m.id === dosa.id).eff === 30);
    ok('online payment is enabled', pub.onlineEnabled === true);

    console.log('Pay at counter');
    const o1 = (await api('POST', '/api/orders', { name: 'Anu', type: 'Parcel', pay: 'COD', items: [{ id: dosa.id, q: 1, p: 1, price: 1 }, { id: coffee.id, q: 1 }] })).body.order;
    ok('price comes from the server, not the browser (30 + 20 + 5 parcel = 55)', o1.total === 55);
    ok('counter order gets token 1 right away', o1.token === 1 && o1.status === 'Preparing');
    ok('stock went down (Dosa 3 -> 2)', (await api('GET', '/api/public')).body.menu.find(m => m.id === dosa.id).qty === 2);

    console.log('Online payment');
    const r2 = (await api('POST', '/api/orders', { name: 'Ravi', type: 'Dine in', pay: 'ONLINE', items: [{ id: dosa.id, q: 2 }] })).body;
    ok('online order is NOT in the queue before payment', r2.order.status === 'PendingPayment' && r2.order.token === null);
    ok('amount sent to Razorpay is in paise (60 rupees = 6000)', r2.amount === 6000);
    ok('unpaid order is not shown in the public queue', (await api('GET', '/api/public')).body.queue.length === 1);
    ok('stock is held while paying (Dosa 0, sold out)', (await api('GET', '/api/public')).body.menu.find(m => m.id === dosa.id).avail === false);
    ok('someone else cannot order the sold-out item', (await api('POST', '/api/orders', { name: 'Z', type: 'Dine in', pay: 'COD', items: [{ id: dosa.id, q: 1 }] })).status === 409);
    const bad = await api('POST', '/api/orders/' + r2.order.id + '/verify', { razorpay_payment_id: 'pay_fake', razorpay_signature: 'f'.repeat(64) });
    ok('a fake payment signature is rejected', bad.status === 400);
    ok('order still unpaid after the fake attempt', (await api('GET', '/api/orders?ids=' + r2.order.id)).body.orders[0].status === 'PendingPayment');
    const sig = (await api('POST', '/api/dev/pay/' + r2.order.id)).body;
    const good = await api('POST', '/api/orders/' + r2.order.id + '/verify', sig);
    ok('a valid payment places the order with token 2', good.status === 200 && good.body.order.status === 'Preparing' && good.body.order.token === 2 && good.body.order.paid === true);
    const again = await api('POST', '/api/orders/' + r2.order.id + '/verify', sig);
    ok('confirming twice does not create a second token', again.body.order.token === 2);

    console.log('Razorpay webhook (customer closed the page after paying)');
    const r3 = (await api('POST', '/api/orders', { name: 'Meera', type: 'Dine in', pay: 'ONLINE', items: [{ id: coffee.id, q: 2 }] })).body;
    const rpOrder = r3.order.rpOrder;
    const hook = async (payload, secret) => { const raw = JSON.stringify(payload); const r = await fetch(S.base + '/api/razorpay/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': crypto.createHmac('sha256', secret).update(raw).digest('hex') }, body: raw }); return { status: r.status }; };
    const ev = amount => ({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_hook1', order_id: rpOrder, amount, status: 'captured' } } } });
    ok('webhook with the wrong secret is refused', (await hook(ev(4000), 'wrong')).status === 400);
    await hook(ev(100), 'mock_webhook');
    ok('webhook with the wrong amount does not place the order', (await api('GET', '/api/orders?ids=' + r3.order.id)).body.orders[0].status === 'PendingPayment');
    ok('valid webhook accepted', (await hook(ev(4000), 'mock_webhook')).status === 200);
    const w = (await api('GET', '/api/orders?ids=' + r3.order.id)).body.orders[0];
    ok('webhook placed the order with token 3', w.status === 'Preparing' && w.token === 3);
    await hook(ev(4000), 'mock_webhook');
    ok('same webhook twice keeps token 3', (await api('GET', '/api/orders?ids=' + r3.order.id)).body.orders[0].token === 3);

    console.log('Cancel and stock');
    const r4 = (await api('POST', '/api/orders', { name: 'Kiran', type: 'Dine in', pay: 'ONLINE', items: [{ id: barotta.id, q: 2 }] })).body;
    ok('Barotta stock held (5 -> 3)', (await api('GET', '/api/public')).body.menu.find(m => m.id === barotta.id).qty === 3);
    await api('POST', '/api/orders/' + r4.order.id + '/cancel');
    ok('student cancel gives the stock back (3 -> 5)', (await api('GET', '/api/public')).body.menu.find(m => m.id === barotta.id).qty === 5);
    ok('a placed order cannot be cancelled by the student', (await api('POST', '/api/orders/' + o1.id + '/cancel')).status === 409);

    console.log('Staff queue');
    ok('cannot skip a step', (await api('POST', '/api/staff/orders/' + o1.id + '/status', { status: 'Delivered' })).status === 409);
    await api('POST', '/api/staff/orders/' + o1.id + '/status', { status: 'Prepared' });
    const del = (await api('POST', '/api/staff/orders/' + o1.id + '/status', { status: 'Delivered' })).body.order;
    ok('cash order is marked paid when handed over', del.status === 'Delivered' && del.paid === true);
    const cn = (await api('POST', '/api/staff/orders/' + r2.order.id + '/cancel')).body.order;
    ok('cancelling a paid online order flags a refund', cn.status === 'Cancelled' && cn.refund === true);
    ok('its stock came back (Dosa 0 -> 2)', (await api('GET', '/api/public')).body.menu.find(m => m.id === dosa.id).qty === 2);
    ok('refund list shows it', (await api('GET', '/api/staff/orders')).body.orders.some(o => o.id === r2.order.id && o.refund));
    await api('POST', '/api/staff/orders/' + r2.order.id + '/refunded');
    ok('refund can be marked done', !(await api('GET', '/api/staff/orders')).body.orders.some(o => o.refund));
    const sales = (await api('GET', '/api/staff/sales')).body;
    ok('sales ignore cancelled orders (55 cash + 40 online)', sales.revenue === 95 && sales.cod === 55 && sales.online === 40);

    console.log('Downloads');
    await api('POST', '/api/orders', { name: '=HYPERLINK("http://x")', type: 'Dine in', pay: 'COD', items: [{ id: coffee.id, q: 1 }] });
    const noauth = await fetch(S.base + '/api/staff/export'); ok('data download needs staff sign-in', noauth.status === 401);
    const exp = await fetch(S.base + '/api/staff/export', { headers: { Authorization: 'Bearer ' + tok.v } });
    const csv = await exp.text();
    ok('spreadsheet file downloads', exp.status === 200 && /text\/csv/.test(exp.headers.get('content-type')) && /attachment/.test(exp.headers.get('content-disposition')));
    ok('it has a header row and every order', csv.includes('Date,Time,Token,Name') && csv.split('\r\n').filter(Boolean).length >= 6);
    ok('it lists the items and payment id', csv.includes('2 x Dosa @ 30') && csv.includes('pay_mock_'));
    ok('a customer name cannot run as a spreadsheet formula', csv.includes("\"'=HYPERLINK") || csv.includes("'=HYPERLINK"));
    const bk = await (await fetch(S.base + '/api/staff/backup', { headers: { Authorization: 'Bearer ' + tok.v } })).json();
    ok('full backup holds the menu and all orders', bk.menu.length === 3 && bk.orders.length >= 5);

    console.log('Safety');
    ok('empty name refused', (await api('POST', '/api/orders', { name: ' ', type: 'Dine in', pay: 'COD', items: [{ id: coffee.id, q: 1 }] })).status === 400);
    ok('absurd quantity refused', (await api('POST', '/api/orders', { name: 'A', type: 'Dine in', pay: 'COD', items: [{ id: coffee.id, q: 999 }] })).status === 400);
    ok('unknown item refused', (await api('POST', '/api/orders', { name: 'A', type: 'Dine in', pay: 'COD', items: [{ id: 'nope', q: 1 }] })).status === 409);
    ok('broken JSON refused', (await api('POST', '/api/orders', null, '{oops')).status === 400);
    const trav = await fetch(S.base + '/..%2fserver.js'); ok('files outside the website folder are not served', trav.status !== 200 || !(await trav.text()).includes('STAFF_PIN'));
    ok('the website itself loads', (await fetch(S.base + '/')).status === 200);

    console.log('Data survives a restart');
    S.p.kill(); await sleep(300);
    const S2 = await start(3902, { DATA_FILE: path.join(S.dir, 'c.json') }); const api2 = call(S2.base, {});
    const after = (await api2('GET', '/api/public')).body;
    ok('menu is still there after restart', after.menu.length === 3);
    ok('orders are still there after restart', (await api2('GET', '/api/orders?ids=' + o1.id)).body.orders.length === 1);
    S2.p.kill();
  } finally { try { S.p.kill(); } catch (e) { /* ignore */ } }

  // ---------- payment timeout ----------
  console.log('Unpaid orders time out');
  const T = await start(3903, { PENDING_MINUTES: '0.005', CLEANUP_MS: '300' }); const tk = { v: '' }; const ap = call(T.base, tk);
  try {
    tk.v = (await ap('POST', '/api/staff/login', { pin: '4321' })).body.token;
    const it = (await ap('POST', '/api/staff/menu', { name: 'Tea', price: 10, qty: 2 })).body.item;
    const r = (await ap('POST', '/api/orders', { name: 'Sam', type: 'Dine in', pay: 'ONLINE', items: [{ id: it.id, q: 2 }] })).body;
    ok('stock held while waiting (2 -> 0)', (await ap('GET', '/api/public')).body.menu[0].qty === 0);
    await sleep(1500);
    ok('after the time limit the order expires', (await ap('GET', '/api/orders?ids=' + r.order.id)).body.orders[0].status === 'Expired');
    ok('and the stock is released (0 -> 2)', (await ap('GET', '/api/public')).body.menu[0].qty === 2);
    const sig = (await ap('POST', '/api/dev/pay/' + r.order.id)).body;
    const late = (await ap('POST', '/api/orders/' + r.order.id + '/verify', sig)).body.order;
    ok('late payment is still honoured if stock is free (token 1)', late.status === 'Preparing' && late.token === 1);
  } finally { T.p.kill(); }

  console.log('\nAll ' + passed + ' checks passed.');
  process.exit(0);
})().catch(e => { console.error('\n' + (e && e.message || e)); process.exit(1); });
