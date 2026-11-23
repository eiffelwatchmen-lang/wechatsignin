import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startTestServer } from './helpers/test-server.js';

let server;
let adminCookie;
let settingsCookie;
before(async () => {
  server = await startTestServer({ preload: new URL('./helpers/mock-wechat.js', import.meta.url).href, env: {
    WECHAT_APP_ID: 'test-app-id', WECHAT_APP_SECRET: 'test-secret', PUBLIC_URL: 'https://event.example.test',
    SETTINGS_PASSWORD: 'settings123'
  } });
  adminCookie = await login('admin');
  settingsCookie = await login('settings');
});
after(async () => { await server?.stop(); });

async function json(url, body, method = 'POST', cookie) {
  const response = await fetch(server.url + url, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json(), cookie: response.headers.getSetCookie()[0]?.split(';')[0] };
}

function checkin(body, cookie) {
  return json('/api/checkin', { phone: '13800138000', ...body }, 'POST', cookie);
}

async function login(role) {
  const passwords = { admin: 'admin123', screen: 'screen123', settings: 'settings123' };
  const response = await fetch(server.url + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, password: passwords[role] })
  });
  assert.equal(response.status, 200);
  return response.headers.getSetCookie()[0].split(';')[0];
}

async function state(cookie = adminCookie) {
  return (await fetch(server.url + '/api/state', { headers: { Cookie: cookie } })).json();
}

test('local check-in stays on the form even with WeChat configured and a WeChat user agent', async () => {
  const current = await state();
  assert.equal(current.config.checkinMode, 'local');
  assert.equal(current.wechat.ready, true);
  const response = await fetch(server.url + '/checkin', {
    headers: { 'User-Agent': 'MicroMessenger/8.0' }, redirect: 'manual'
  });
  assert.equal(response.status, 200);
});

test('only an administrator can pause sign-in; paused submissions are blocked until reopened', async () => {
  const screenCookie = await login('screen');
  assert.equal((await json('/api/checkin/status', { checkinEnabled: false }, 'PUT')).status, 401);
  for (const cookie of [screenCookie, settingsCookie]) {
    assert.equal((await json('/api/checkin/status', { checkinEnabled: false }, 'PUT', cookie)).status, cookie === settingsCookie ? 401 : 403);
  }
  assert.equal((await json('/api/checkin/status', { checkinEnabled: 'false' }, 'PUT', adminCookie)).status, 400);
  try {
    assert.equal((await json('/api/checkin/status', { checkinEnabled: false }, 'PUT', adminCookie)).status, 200);
    const anonymous = await (await fetch(server.url + '/api/state')).json();
    assert.equal(anonymous.config.checkinEnabled, false);
    const count = (await state()).attendees.length;
    const blocked = await checkin({ name: '尚未开始' });
    assert.equal(blocked.status, 403);
    assert.match(blocked.body.message, /暂停/);
    assert.equal((await state()).attendees.length, count);
    const oauth = await fetch(server.url + '/wechat/oauth/start', { redirect: 'manual' });
    assert.equal(oauth.headers.get('location'), '/checkin');
  } finally {
    await json('/api/checkin/status', { checkinEnabled: true }, 'PUT', adminCookie);
  }
  assert.equal((await checkin({ name: '开始后的签到' })).status, 200);
});

test('screen QR updates persist layout without changing protected settings', async () => {
  const screenCookie = await login('screen');
  const before = (await state()).config;
  assert.equal((await json('/api/screen/qr-layout', { qrSize: 240 }, 'PUT')).status, 401);
  const updated = await json('/api/screen/qr-layout', {
    qrSize: 320, qrPosition: { x: 660, y: 40 }, eventTitle: '伪造标题', checkinEnabled: false, adminPassword: 'not-allowed'
  }, 'PUT', screenCookie);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.qrSize, 320);
  assert.deepEqual(updated.body.qrPosition, { x: 660, y: 40 });
  const config = (await state()).config;
  assert.equal(config.eventTitle, before.eventTitle);
  assert.equal(config.checkinEnabled, before.checkinEnabled);
  assert.equal((await login('admin')).startsWith('checkin-staff='), true);
  const bounded = await json('/api/screen/qr-layout', { qrSize: 999, qrPosition: { x: -1, y: 9999 } }, 'PUT', screenCookie);
  assert.deepEqual(bounded.body, { qrSize: 480, qrPosition: { x: 0, y: 2000 } });
});

test('local check-in validates the phone and generates an escaped name avatar', async () => {
  const result = await checkin({ phone: '+86 138-0013-8000', name: '  嘉宾 <甲&>  ', source: 'local-form' });
  assert.equal(result.status, 200);
  assert.equal(result.body.attendee.name, '嘉宾 <甲&>');
  assert.equal(result.body.attendee.phone, '13800138000');
  assert.equal(result.body.attendee.nickname, '嘉宾 <甲&>');
  const svg = Buffer.from(result.body.attendee.avatar.split(',')[1], 'base64').toString();
  assert.match(svg, /&amp;&gt;/);
  assert.doesNotMatch(svg, /<甲/);
});

test('blank names are rejected without creating a record', async () => {
  const count = (await state()).attendees.length;
  const result = await checkin({ visitorId: 'blank', name: '   ', source: 'local-form' });
  assert.equal(result.status, 400);
  assert.equal(result.body.message, '请填写姓名');
  assert.equal((await state()).attendees.length, count);
});

test('phone is required and invalid values do not create a record', async () => {
  const count = (await state()).attendees.length;
  for (const phone of [undefined, '   ', '13800138000x', '12345']) {
    assert.equal((await json('/api/checkin', { name: '来宾', phone })).status, 400);
  }
  assert.equal((await state()).attendees.length, count);
});

test('repeated submissions update the same attendee and preserve the check-in time', async () => {
  const first = await checkin({ visitorId: 'repeat', name: '王小明', source: 'local-form' });
  const count = (await state()).attendees.length;
  const second = await checkin({ visitorId: 'repeat', name: '李小华', phone: '13900139000', avatar: '' }, first.cookie);
  assert.equal(second.body.existing, true);
  assert.equal(second.body.attendee.id, first.body.attendee.id);
  assert.equal(second.body.attendee.checkedInAt, first.body.attendee.checkedInAt);
  assert.equal(second.body.attendee.name, '李小华');
  assert.notEqual(second.body.attendee.avatar, first.body.attendee.avatar);
  assert.equal((await state()).attendees.length, count);
});

test('two guests with the same name are not merged', async () => {
  const first = await checkin({ visitorId: 'same-name-a', name: '张三', source: 'local-form' });
  const second = await checkin({ visitorId: 'same-name-b', name: '张三', source: 'local-form' });
  assert.notEqual(first.body.attendee.id, second.body.attendee.id);
});

test('profile edits retain the company and the owner can read their own phone', async () => {
  const first = await checkin({ name: '历史来宾', phone: '+1 415 555 0123', company: '测试单位' });
  const result = await checkin({ name: '历史来宾新名', phone: '+1 415 555 0123' }, first.cookie);
  assert.equal(result.body.attendee.phone, '+14155550123');
  assert.equal(result.body.attendee.company, '测试单位');
  assert.equal((await state(first.cookie)).selfAttendee.phone, '+14155550123');
  assert.ok(!(await state('')).attendees.length);
  assert.equal((await state('')).selfAttendee, null);
  assert.ok((await state(await login('screen'))).attendees.every((attendee) => attendee.phone === undefined));
  assert.equal((await fetch(server.url + '/api/attendees')).status, 401);
  assert.equal((await fetch(server.url + '/api/export/checkins.xlsx')).status, 401);
  assert.equal((await fetch(server.url + '/socket.io/?EIO=4&transport=polling')).status, 403);
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=', 'base64');

async function upload(buffer, name, type) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), name);
  const response = await fetch(server.url + '/api/checkin/avatar', { method: 'POST', body: form });
  return { status: response.status, body: await response.json() };
}

test('uploaded raster avatars are served locally and survive check-in', async () => {
  const image = await upload(png, 'photo.png', 'image/png');
  assert.equal(image.status, 200);
  assert.match(image.body.url, /^\/uploads\/avatar-[a-f0-9-]+\.png$/);
  const fetched = await fetch(server.url + image.body.url);
  assert.equal(fetched.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), png);
  const result = await checkin({ visitorId: 'photo-guest', name: '头像来宾', avatar: image.body.url, source: 'local-form' });
  assert.equal(result.status, 200);
  assert.equal(result.body.attendee.avatar, image.body.url);
  const reset = await checkin({ visitorId: 'photo-guest', name: '头像来宾', avatar: '' }, result.cookie);
  assert.equal(reset.body.attendee.id, result.body.attendee.id);
  assert.match(reset.body.attendee.avatar, /^data:image\/svg\+xml;base64,/);
});

test('SVG and disguised non-image uploads are rejected without leaving files', async () => {
  const directory = path.join(server.directory, 'assets/uploads');
  const count = fs.readdirSync(directory).length;
  for (const [name, type] of [['photo.svg', 'image/svg+xml'], ['fake.png', 'image/png']]) {
    const result = await upload(Buffer.from('<svg><script>alert(1)</script></svg>'), name, type);
    assert.equal(result.status, 400);
  }
  assert.equal(fs.readdirSync(directory).length, count);
});

test('oversized and missing avatar uploads return a useful error', async () => {
  const result = await upload(Buffer.alloc(2 * 1024 * 1024 + 1), 'large.png', 'image/png');
  assert.equal(result.status, 400);
  assert.match(result.body.message, /2 MB/);
  const empty = await fetch(server.url + '/api/checkin/avatar', { method: 'POST', body: new FormData() });
  assert.equal(empty.status, 400);
});

test('local sign-in rejects missing, external and executable avatar URLs', async () => {
  for (const avatar of ['/uploads/avatar-123.png', 'https://example.test/photo.png', 'data:image/svg+xml,<svg/>', '/uploads/../server.js']) {
    const result = await checkin({ visitorId: 'bad-avatar', name: '头像测试', avatar, source: 'local-form' });
    assert.equal(result.status, 400);
  }
});

test('legacy WeChat mode uses the same authorization and requires both fields to check in', async () => {
  assert.equal((await json('/api/config', { checkinMode: 'wechat' }, 'PUT', settingsCookie)).status, 200);
  const response = await fetch(server.url + '/checkin', { headers: { 'User-Agent': 'MicroMessenger/8.0' }, redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/wechat/oauth/start');
  try {
    const storePath = path.join(server.directory, 'data/store.json');
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const previous = {
      id: 'legacy-wechat', openid: 'test-openid-one', name: '历史微信来宾', phone: '',
      source: 'wechat-oauth', checkedInAt: '2026-01-01T00:00:00.000Z'
    };
    store.attendees.push(previous);
    fs.writeFileSync(storePath, JSON.stringify(store));
    const count = (await state()).attendees.length;
    const headers = { 'User-Agent': 'MicroMessenger/8.0' };
    const beginning = await fetch(server.url + '/wechat/oauth/start', { headers, redirect: 'manual' });
    const auth = new URL(beginning.headers.get('location'));
    const params = new URLSearchParams({ code: 'accepted', state: auth.searchParams.get('state') });
    const callback = await fetch(`${server.url}/wechat/oauth/callback?${params}`, {
      headers: { ...headers, Cookie: beginning.headers.getSetCookie()[0].split(';')[0] }, redirect: 'manual'
    });
    assert.equal(callback.headers.get('location'), '/checkin?wechat=authorized');
    const cookie = callback.headers.getSetCookie().find((value) => value.startsWith('__Host-checkin-wechat=')).split(';')[0];
    assert.equal((await state()).attendees.length, count);
    assert.equal((await state(cookie)).selfAttendee.phone, '');
    assert.equal((await json('/api/checkin', { name: '授权来宾' }, 'POST', cookie)).status, 400);
    assert.equal((await checkin({ name: '授权来宾' })).status, 401);
    const saved = await checkin({ name: '授权来宾' }, cookie);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.attendee.id, previous.id);
    assert.equal(saved.body.attendee.checkedInAt, previous.checkedInAt);
    assert.equal((await state()).attendees.length, count);
    assert.match(saved.body.attendee.avatar, /^https:\/\/thirdwx\.qlogo\.cn/);
    assert.equal(saved.body.attendee.phone, '13800138000');
  } finally {
    await json('/api/config', { checkinMode: 'local' }, 'PUT', settingsCookie);
  }
});

test('local attendees can enter the draw and administrators can export their phone', async () => {
  const guest = await checkin({ visitorId: 'draw-guest', name: '抽奖来宾', source: 'local-form' });
  const id = guest.body.attendee.id;
  assert.equal((await json('/api/prizes/grand-prize/fixed-winners', { attendeeId: id }, 'POST', adminCookie)).status, 200);
  const result = await json('/api/draw', { prizeId: 'grand-prize', count: 1 }, 'POST', adminCookie);
  assert.equal(result.status, 200);
  assert.equal(result.body.winners[0].attendeeId, id);
  assert.equal(result.body.winners[0].avatar, guest.body.attendee.avatar);
  const exported = await fetch(server.url + '/api/export/checkins.xlsx', { headers: { Cookie: adminCookie } });
  assert.equal(exported.status, 200);
  assert.ok((await exported.arrayBuffer()).byteLength > 100);
});

test('display settings require their own session on the LAN', async () => {
  const screenCookie = await login('screen');
  assert.equal((await json('/api/config', { qrSize: 140 }, 'PUT')).status, 401);
  assert.equal((await json('/api/config', { qrSize: 140 }, 'PUT', screenCookie)).status, 403);
  assert.equal((await json('/api/config', { qrSize: 140 }, 'PUT', adminCookie)).status, 403);
  assert.equal((await json('/api/reset', { scope: 'all' }, 'POST', adminCookie)).status, 403);
  assert.equal((await json('/api/login', { role: 'settings', password: 'admin123' })).status, 401);
  assert.equal((await json('/api/login', { role: 'settings', password: 'screen123' })).status, 401);
  assert.equal((await json('/api/config', { adminPassword: 'changed' }, 'PUT', settingsCookie)).status, 403);
  assert.equal((await json('/api/config', { screenPassword: 'settings123' }, 'PUT', `${adminCookie}; ${settingsCookie}`)).status, 400);
  assert.equal((await json('/api/upload/logo', {}, 'POST', adminCookie)).status, 403);
  const result = await json('/api/config', { qrSize: 140, qrPosition: { x: 860, y: 36 } }, 'PUT', settingsCookie);
  assert.equal(result.status, 200);
  assert.equal(result.body.config.qrSize, 140);
  assert.deepEqual(result.body.config.qrPosition, { x: 860, y: 36 });
  const cookies = `${adminCookie}; ${settingsCookie}`;
  const profile = await (await fetch(server.url + '/api/state', { headers: { Cookie: cookies } })).json();
  assert.equal(profile.accessRole, 'admin');
  assert.equal(profile.hasSettingsAccess, true);
  assert.equal((await json('/api/logout', { role: 'settings' }, 'POST', cookies)).status, 200);
  const loggedOut = await (await fetch(server.url + '/api/state', { headers: { Cookie: cookies } })).json();
  assert.equal(loggedOut.accessRole, 'admin');
  assert.equal(loggedOut.hasSettingsAccess, false);
});

test('signing in and saving a prize never adds presets; explicit additions and removals stay scoped to that prize', async () => {
  const guest = await checkin({ visitorId: 'manual-presets', name: '待选签到来宾' });
  const id = guest.body.attendee.id;
  const created = await json('/api/prizes', { name: '测试奖项', quantity: 3, fixedWinnerIds: [id] });
  assert.deepEqual(created.body.fixedWinnerIds, []);
  const route = `/api/prizes/${created.body.id}`;
  const fixed = `${route}/fixed-winners`;
  assert.equal((await json(fixed, { attendeeId: id })).status, 401);
  assert.equal((await json(fixed, { attendeeId: 'missing' }, 'POST', adminCookie)).status, 404);
  const updated = await json(route, { name: '改名后的奖项', fixedWinnerIds: [id] }, 'PUT', adminCookie);
  assert.deepEqual(updated.body.fixedWinnerIds, []);

  for (let repeat = 0; repeat < 2; repeat += 1) {
    const added = await json(fixed, { attendeeId: id }, 'POST', adminCookie);
    assert.deepEqual(added.body.fixedWinnerIds, [id]);
  }
  assert.equal((await state()).prizes.find((prize) => prize.id === 'second-prize').fixedWinnerIds.length, 0);
  const saved = await json(route, { quantity: 2, fixedWinnerIds: [] }, 'PUT', adminCookie);
  assert.deepEqual(saved.body.fixedWinnerIds, [id]);
  const removed = await json(`${fixed}/${id}`, undefined, 'DELETE', adminCookie);
  assert.deepEqual(removed.body.fixedWinnerIds, []);
  const draw = await json('/api/draw', { prizeId: created.body.id, count: 1 }, 'POST', adminCookie);
  assert.equal(draw.body.winners[0].fixed, false);
  assert.ok((await state()).attendees.some((attendee) => attendee.id === id));

  await json(fixed, { attendeeId: id }, 'POST', adminCookie);
  await json(`/api/attendees/${id}`, undefined, 'DELETE', adminCookie);
  assert.deepEqual((await state()).prizes.find((prize) => prize.id === created.body.id).fixedWinnerIds, []);
});
