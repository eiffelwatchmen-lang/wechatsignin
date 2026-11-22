import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createPublicAccess } from '../src/public-access.js';
import { startTestServer } from './helpers/test-server.js';

const origin = 'https://checkin.example.test';
const adminPassword = 'test-admin-password-1234';
const screenPassword = 'test-screen-password-1234';
const settingsPassword = 'test-settings-password-1234';
const avatarUrl = 'https://thirdwx.qlogo.cn/mmopen/test-avatar/132';
const credentials = {
  PUBLIC_DEPLOYMENT: '1', PUBLIC_URL: origin, ADMIN_PASSWORD: adminPassword,
  SCREEN_PASSWORD: screenPassword, SETTINGS_PASSWORD: settingsPassword
};
let server;
let guestCookie;
let guestId;
let adminCookie;
let screenCookie;

before(async () => {
  server = await startTestServer({
    env: { ...credentials, WECHAT_APP_ID: 'test-app-id', WECHAT_APP_SECRET: 'test-app-secret' },
    preload: new URL('./helpers/mock-wechat.js', import.meta.url).href
  });
});
after(async () => { await server?.stop(); });

function request(route, { method = 'GET', cookie, body, from = origin, client = '192.0.2.20', wechat = false } = {}) {
  const headers = { 'X-Forwarded-For': client };
  if (from) headers.Origin = from;
  if (cookie) headers.Cookie = cookie;
  if (wechat) headers['User-Agent'] = 'MicroMessenger/8.0';
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  return fetch(server.url + route, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(4000) });
}

function cookieFrom(response, kind) {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`__Host-checkin-${kind}=`));
  assert.ok(cookie, `expected a ${kind} cookie`);
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; Secure/);
  assert.ok(cookie.includes(['staff', 'settings'].includes(kind) ? '; SameSite=Strict' : '; SameSite=Lax'));
  return cookie.split(';')[0];
}

async function beginAuthorization() {
  const response = await request('/wechat/oauth/start', { wechat: true });
  assert.equal(response.status, 302);
  const redirect = new URL(response.headers.get('location'));
  assert.equal(redirect.origin, 'https://open.weixin.qq.com');
  assert.equal(redirect.searchParams.get('scope'), 'snsapi_userinfo');
  assert.equal(redirect.searchParams.get('redirect_uri'), origin + '/wechat/oauth/callback');
  const cookie = cookieFrom(response, 'oauth');
  const state = redirect.searchParams.get('state');
  assert.match(state, /^[a-f0-9]{64}$/);
  assert.notEqual(cookie.split('=')[1], state);
  return { cookie, state };
}

function callback({ state, cookie }, code = 'accepted') {
  return request(`/wechat/oauth/callback?${new URLSearchParams({ state, code })}`, { cookie });
}

async function authorize(code) {
  const response = await callback(await beginAuthorization(), code);
  assert.equal(response.headers.get('location'), '/checkin?wechat=authorized');
  return cookieFrom(response, 'wechat');
}

test('public startup requires HTTPS and distinct non-default passwords', () => {
  assert.equal(createPublicAccess({}), null);
  assert.throws(() => createPublicAccess({ PUBLIC_DEPLOYMENT: '1', PUBLIC_URL: 'http://example.test' }), /HTTPS/);
  assert.throws(() => createPublicAccess({ PUBLIC_DEPLOYMENT: '1', PUBLIC_URL: origin + '/path' }), /HTTPS/);
  assert.throws(() => createPublicAccess({ PUBLIC_DEPLOYMENT: '1', PUBLIC_URL: origin, ADMIN_PASSWORD: 'admin123' }), /password|PASSWORD/);
  assert.throws(() => createPublicAccess({ ...credentials, SETTINGS_PASSWORD: adminPassword }), /SETTINGS_PASSWORD/);
  assert.equal(createPublicAccess({ ...credentials, SETTINGS_PASSWORD: '' }).settingsReady, false);
});

test('anonymous access exposes only activity information and cannot manage the event', async () => {
  const state = await request('/api/state');
  assert.equal(state.headers.get('cache-control'), 'no-store');
  const data = await state.json();
  assert.equal(data.deployment, 'public');
  assert.equal(data.checkinUrl, origin + '/checkin');
  assert.equal(data.config.checkinMode, 'wechat');
  assert.deepEqual(data.wechat, { ready: true, profile: null });
  assert.equal(data.accessRole, null);
  assert.deepEqual(data.attendees, []);
  assert.deepEqual(data.prizes, []);
  assert.deepEqual(data.winners, []);
  assert.equal(data.selfAttendee, null);
  for (const [method, route] of [
    ['GET', '/api/attendees'], ['GET', '/api/winners'], ['GET', '/api/prizes'],
    ['GET', '/api/export/checkins.xlsx'], ['GET', '/api/export/winners.xlsx'],
    ['POST', '/api/draw'], ['POST', '/api/reset'], ['PUT', '/api/config'],
    ['POST', '/api/prizes'], ['POST', '/api/demo/seed'], ['POST', '/api/upload/logo'],
    ['DELETE', '/api/attendees/test'], ['DELETE', '/api/winners/test']
  ]) assert.equal((await request(route, { method })).status, 401, route);
  assert.equal((await request('/wechat/oauth/start')).headers.get('location'), '/checkin?wechat=outside');
  assert.equal((await request('/checkin')).status, 200);
  assert.equal((await request('/checkin', { wechat: true })).headers.get('location'), '/wechat/oauth/start');
  assert.equal((await request('/checkin?wechat=denied', { wechat: true })).status, 200);
  assert.equal((await request('/api/checkin/avatar', { method: 'POST' })).status, 404);
  assert.equal((await request('/api/checkin', { method: 'POST', body: { name: '伪造身份', openid: 'test-openid-one' } })).status, 401);
  const qr = await request('/api/qrcode.svg');
  assert.equal(qr.status, 200);
  assert.equal(await qr.text(), await (await request('/api/qrcode.svg?target=https://other.example.test')).text());
  assert.equal((await request('/socket.io/?EIO=4&transport=polling')).status, 403);
});

test('OAuth callbacks require the initiating browser and a one-time state', async () => {
  const pending = await beginAuthorization();
  assert.equal((await callback({ state: pending.state })).headers.get('location'), '/checkin?wechat=failed');
  assert.equal((await callback({ ...pending, state: 'wrong-state' })).headers.get('location'), '/checkin?wechat=failed');
  const successful = await callback(pending);
  assert.equal(successful.headers.get('location'), '/checkin?wechat=authorized');
  guestCookie = cookieFrom(successful, 'wechat');
  assert.equal((await callback(pending)).headers.get('location'), '/checkin?wechat=failed');
  assert.equal((await callback(await beginAuthorization(), 'authdeny')).headers.get('location'), '/checkin?wechat=denied');
  for (const code of ['invalid', 'mismatch', 'base-only']) {
    const response = await callback(await beginAuthorization(), code);
    assert.equal(response.headers.get('location'), '/checkin?wechat=failed');
    assert.ok(!response.headers.getSetCookie().some((cookie) => cookie.startsWith('__Host-checkin-wechat=')));
  }
});

test('the confirmed name and phone are saved with the verified avatar', async () => {
  const before = await (await request('/api/state', { cookie: guestCookie })).json();
  assert.deepEqual(before.wechat.profile, { nickname: '微信测试昵称', avatar: avatarUrl });
  assert.equal(before.selfAttendee, null);
  assert.equal((await request('/checkin', { cookie: guestCookie, wechat: true })).status, 200);
  assert.equal((await request('/api/checkin', { method: 'POST', cookie: guestCookie, body: { name: ' ' } })).status, 400);
  for (const phone of [undefined, ' ', '12345']) {
    assert.equal((await request('/api/checkin', { method: 'POST', cookie: guestCookie, body: { name: '测试来宾', phone } })).status, 400);
  }
  const saved = await request('/api/checkin', { method: 'POST', cookie: guestCookie, body: {
    name: '测试来宾', nickname: '伪造昵称', avatar: 'https://example.test/forged.png', phone: '13800138000', openid: 'spoof', source: 'local-form'
  } });
  assert.equal(saved.status, 200);
  const attendee = (await saved.json()).attendee;
  guestId = attendee.id;
  assert.equal(attendee.avatar, avatarUrl);
  assert.equal(attendee.nickname, '微信测试昵称');
  assert.equal(attendee.openid, undefined);
  assert.equal(attendee.phone, '13800138000');

  const ownerState = await (await request('/api/state', { cookie: guestCookie })).json();
  assert.equal(ownerState.selfAttendee.id, guestId);
  assert.equal(ownerState.selfAttendee.phone, '13800138000');
  assert.deepEqual(ownerState.attendees, []);
  const anonymous = await (await request('/api/state')).json();
  assert.equal(anonymous.selfAttendee, null);
  assert.equal(anonymous.wechat.profile, null);
  assert.doesNotMatch(JSON.stringify(ownerState), /test-openid|test-token|test-app-secret/);
  const authorizedAgain = await authorize('again');
  const edited = await request('/api/checkin', { method: 'POST', cookie: authorizedAgain, body: { name: '修改姓名', phone: '13900139000' } });
  const result = await edited.json();
  assert.equal(result.existing, true);
  assert.equal(result.attendee.id, guestId);
  assert.equal(result.attendee.checkedInAt, attendee.checkedInAt);
  assert.equal(result.attendee.phone, '13900139000');
});

test('staff sessions are server-side and role permissions are distinct', async () => {
  const login = (role, password, from = origin) => request('/api/login', { method: 'POST', body: { role, password }, from });
  assert.equal((await login('admin', 'admin123')).status, 401);
  assert.equal((await login('admin', adminPassword, 'https://other.example.test')).status, 403);
  adminCookie = cookieFrom(await login('admin', adminPassword), 'staff');
  screenCookie = cookieFrom(await login('screen', screenPassword), 'staff');
  const admin = await (await request('/api/state', { cookie: adminCookie })).json();
  assert.equal(admin.accessRole, 'admin');
  assert.equal(admin.attendees[0].id, guestId);
  assert.equal(admin.attendees[0].phone, '13900139000');
  assert.match(admin.attendees[0].openid, /^wechat-[a-f0-9]{64}$/);
  assert.equal(admin.config.adminPassword, undefined);
  assert.equal(admin.loginDefaults, undefined);
  assert.equal((await request('/api/checkin/avatar', { method: 'POST', cookie: adminCookie })).status, 404);
  assert.equal((await request('/api/export/checkins.xlsx', { cookie: adminCookie })).status, 200);

  const screen = await (await request('/api/state', { cookie: screenCookie })).json();
  assert.equal(screen.accessRole, 'screen');
  assert.equal(screen.attendees[0].id, guestId);
  assert.equal(screen.attendees[0].openid, undefined);
  assert.equal(screen.attendees[0].phone, undefined);
  assert.equal(screen.prizes[0].fixedWinnerIds, undefined);
  assert.equal((await request('/api/export/checkins.xlsx', { cookie: screenCookie })).status, 403);
  assert.equal((await request('/api/reset', { method: 'POST', cookie: screenCookie, body: { scope: 'all' } })).status, 403);
  assert.equal((await request('/api/config', { method: 'PUT', cookie: screenCookie, body: { eventTitle: '修改' } })).status, 403);
  assert.equal((await request('/api/config', { method: 'PUT', cookie: screenCookie, body: { qrSize: 140 } })).status, 403);
  assert.equal((await request('/api/config', { method: 'PUT', cookie: adminCookie, body: { qrSize: 140 } })).status, 403);
  assert.equal((await login('settings', adminPassword)).status, 401);
  assert.equal((await login('settings', screenPassword)).status, 401);
  const settingsCookie = cookieFrom(await login('settings', settingsPassword), 'settings');
  const settings = await (await request('/api/state', { cookie: settingsCookie })).json();
  assert.equal(settings.hasSettingsAccess, true);
  assert.equal(settings.accessRole, null);
  assert.deepEqual(settings.attendees, []);
  assert.equal((await request('/api/export/checkins.xlsx', { cookie: settingsCookie })).status, 403);
  assert.equal((await request('/api/upload/logo', { method: 'POST', cookie: adminCookie })).status, 403);
  const logo = new FormData();
  logo.append('file', new Blob([Buffer.from('test')], { type: 'image/png' }), 'logo.png');
  const uploaded = await request('/api/upload/logo', { method: 'POST', cookie: settingsCookie, body: logo });
  assert.equal(uploaded.status, 200);
  const { url } = await uploaded.json();
  assert.equal((await request(url, { cookie: settingsCookie })).status, 200);
  assert.equal((await request(url)).status, 404);
  const saved = await request('/api/config', { method: 'PUT', cookie: settingsCookie, body: { qrSize: 140 } });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).config.qrSize, 140);
  assert.equal((await request('/api/prizes/grand-prize/fixed-winners', {
    method: 'POST', cookie: screenCookie, body: { attendeeId: guestId }
  })).status, 403);
  assert.equal((await request('/api/config', { method: 'PUT', cookie: settingsCookie, from: 'https://other.example.test', body: { qrSize: 88 } })).status, 403);
  assert.equal((await request('/api/qrcode.svg', { cookie: screenCookie })).status, 200);

  const draw = await request('/api/draw', { method: 'POST', cookie: screenCookie, body: { prizeId: 'grand-prize', count: 1 } });
  assert.equal(draw.status, 200);
  const { winners, prize } = await draw.json();
  assert.equal(winners[0].attendeeId, guestId);
  assert.equal(winners[0].phone, undefined);
  assert.equal(prize.fixedWinnerIds, undefined);
});

test('Socket.IO delivers filtered live updates only to logged-in staff', async () => {
  const polling = '/socket.io/?EIO=4&transport=polling';
  assert.equal((await request(polling, { cookie: screenCookie, from: 'https://other.example.test' })).status, 403);
  const handshake = await request(polling, { cookie: screenCookie });
  assert.equal(handshake.status, 200);
  const { sid } = JSON.parse((await handshake.text()).slice(1));
  const socketUrl = `${polling}&sid=${sid}`;
  const attach = await fetch(server.url + socketUrl, {
    method: 'POST', body: '40', headers: { Cookie: screenCookie }, signal: AbortSignal.timeout(4000)
  });
  assert.equal(attach.status, 200);
  const initial = await (await request(socketUrl, { cookie: screenCookie })).text();
  assert.match(initial, /"accessRole":"screen"/);
  assert.doesNotMatch(initial, /"openid"|"fixedWinnerIds"|"phone"/);
  const secondGuest = await authorize('second');
  const secondState = await (await request('/api/state', { cookie: secondGuest })).json();
  assert.equal(secondState.selfAttendee, null);
  const added = await request('/api/checkin', { method: 'POST', cookie: secondGuest, body: { name: '实时签到来宾', phone: '13700137000' } });
  assert.equal(added.status, 200);
  const update = await (await request(socketUrl, { cookie: screenCookie })).text();
  assert.match(update, /实时签到来宾/);
  assert.match(update, /checkin:new/);
  assert.doesNotMatch(update, /"openid"|"phone"/);
  assert.equal((await request('/api/logout', { method: 'POST', cookie: screenCookie })).status, 200);
  assert.equal((await request(polling, { cookie: screenCookie })).status, 403);
  assert.equal((await request('/api/draw', { method: 'POST', cookie: screenCookie, body: { prizeId: 'second-prize' } })).status, 401);
});

test('a WeChat account without an avatar receives a generated name avatar', async () => {
  const otherGuest = await authorize('no-avatar');
  const guest = await request('/api/checkin', {
    method: 'POST', cookie: otherGuest, body: { name: '姓名头像来宾', phone: '13700137000', avatar: 'https://example.test/forged.png' }
  });
  assert.equal(guest.status, 200);
  const { attendee } = await guest.json();
  assert.notEqual(attendee.id, guestId);
  assert.match(attendee.avatar, /^data:image\/svg\+xml;base64,/);
});

test('missing official-account credentials do not enable public manual check-in', async () => {
  const fixture = await startTestServer({ env: credentials });
  try {
    const state = await (await fetch(fixture.url + '/api/state')).json();
    assert.deepEqual(state.wechat, { ready: false, profile: null });
    const response = await fetch(fixture.url + '/checkin', {
      headers: { 'User-Agent': 'MicroMessenger/8.0' }, redirect: 'manual'
    });
    assert.equal(response.status, 200);
  } finally {
    await fixture.stop();
  }
});

test('login throttling groups attempts by client IP, not a forwarded source port', async () => {
  for (let attempt = 0; attempt < 21; attempt += 1) {
    const result = await request('/api/login', {
      method: 'POST', body: { password: 'wrong' }, client: `192.0.2.42:${40000 + attempt}`
    });
    assert.equal(result.status, attempt < 20 ? 401 : 429);
    if (attempt === 20) assert.ok(Number(result.headers.get('retry-after')) > 0);
  }
});
