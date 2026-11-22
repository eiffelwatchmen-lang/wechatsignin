import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.resolve(import.meta.dirname, '../src/public/app.js'), 'utf8');

function browser() {
  const app = { innerHTML: '' };
  const selectors = new Map([
    ['#app', app],
    ['#editCheckin', { addEventListener() {} }],
    ['#checkinError', { textContent: '' }],
    ['#checkinName', { focus() {} }],
    ['#checkinPhone', { focus() {} }],
    ['#submitCheckin span', { textContent: '' }]
  ]);
  const events = new Map();
  const context = vm.createContext({
    document: {
      querySelector: (selector) => selectors.get(selector) || null,
      querySelectorAll: () => [], addEventListener() {}
    },
    window: { location: { pathname: '/checkin', search: '' }, addEventListener() {} },
    navigator: { userAgent: 'MicroMessenger/8.0' },
    location: { origin: 'http://example.test' },
    URLSearchParams, FormData,
    io: () => ({ on: (event, callback) => events.set(event, callback) }),
    btoa: (value) => Buffer.from(value, 'binary').toString('base64')
  });
  vm.runInContext(source, context);
  vm.runInContext(`state = { config: { checkinMode: 'local' }, attendees: [], wechat: { ready: true } };`, context);
  context.bindLocalCheckinForm = () => {};
  return { context, app, selectors, events, run: (code) => vm.runInContext(code, context) };
}

test('local mode shows required contact fields and an optional avatar even inside WeChat', () => {
  const ui = browser();
  ui.context.renderCheckin();
  assert.match(ui.app.innerHTML, /id="localCheckinForm"/);
  assert.match(ui.app.innerHTML, /name="name"[^>]*required/);
  assert.match(ui.app.innerHTML, /name="phone"[^>]*type="tel"[^>]*required/);
  assert.match(ui.app.innerHTML, /头像（选填）/);
  assert.doesNotMatch(ui.app.innerHTML, /微信授权未配置|打开微信授权/);
});

test('settings expose a labeled local and WeChat mode selector', () => {
  const ui = browser();
  const html = ui.context.renderSettingsPanel();
  assert.match(html, /name="checkinMode" aria-label="签到方式"/);
  assert.match(html, /value="local" selected/);
  assert.match(html, /value="wechat"/);
});

test('an older check-in without a phone opens the form to complete the record', () => {
  const ui = browser();
  ui.run(`state.selfAttendee = { id: 'older', name: '已签到来宾' };`);
  ui.context.renderCheckin();
  assert.match(ui.app.innerHTML, /name="phone"[^>]*required/);
  assert.match(ui.app.innerHTML, /value="已签到来宾"/);
});

test('an existing local visitor sees a success screen instead of a second form', () => {
  const ui = browser();
  ui.run(`state.selfAttendee = { id: 'saved', name: '已签到来宾', phone: '13800138000' };`);
  ui.context.renderCheckin();
  assert.match(ui.app.innerHTML, /签到成功|已签到来宾|修改资料/);
  assert.doesNotMatch(ui.app.innerHTML, /id="localCheckinForm"/);
});

test('check-in pages do not subscribe to staff updates', () => {
  const ui = browser();
  ui.run(`state.accessRole = 'admin';`);
  ui.context.connectSocket();
  assert.equal(ui.events.size, 0);
});

test('double submission sends one request with both fields and caches the saved attendee', async () => {
  const ui = browser();
  let finish;
  const calls = [];
  let renders = 0;
  ui.context.renderLocalCheckin = () => { renders += 1; };
  ui.context.api = (url, options) => {
    calls.push({ url, body: JSON.parse(JSON.stringify(options.body)) });
    return new Promise((resolve) => { finish = resolve; });
  };
  ui.run(`checkinUiState.name = '  王小明  '; checkinUiState.phone = '13800138000';`);
  const event = { preventDefault() {} };
  const first = ui.context.submitLocalCheckin(event);
  await ui.context.submitLocalCheckin(event);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.name, '王小明');
  assert.equal(calls[0].body.phone, '13800138000');
  finish({ attendee: { id: 'saved', name: '王小明', phone: '13800138000' } });
  await first;
  assert.equal(ui.run('state.selfAttendee.id'), 'saved');
  assert.equal(ui.run('checkinUiState.submitting'), false);
  assert.equal(renders, 1);
});

test('a submission error keeps the draft and enables retry', async () => {
  const ui = browser();
  ui.run(`checkinUiState.name = '保留姓名'; checkinUiState.phone = '13800138000';`);
  ui.context.api = async () => { throw new Error('网络连接失败，请重试'); };
  await ui.context.submitLocalCheckin({ preventDefault() {} });
  assert.equal(ui.run('checkinUiState.name'), '保留姓名');
  assert.equal(ui.run('checkinUiState.phone'), '13800138000');
  assert.equal(ui.run('checkinUiState.submitting'), false);
  assert.equal(ui.run('state.attendees.length'), 0);
  assert.equal(ui.selectors.get('#checkinError').textContent, '网络连接失败，请重试');
});

test('whitespace-only names never send a request', async () => {
  const ui = browser();
  ui.run(`checkinUiState.name = '   ';`);
  ui.context.api = () => { throw new Error('Should not submit'); };
  await ui.context.submitLocalCheckin({ preventDefault() {} });
  assert.equal(ui.selectors.get('#checkinError').textContent, '请填写姓名');
});

test('a missing phone never sends a request', async () => {
  const ui = browser();
  ui.run(`checkinUiState.name = '来宾'; checkinUiState.phone = '   ';`);
  ui.context.api = () => { throw new Error('Should not submit'); };
  await ui.context.submitLocalCheckin({ preventDefault() {} });
  assert.equal(ui.selectors.get('#checkinError').textContent, '请填写手机号');
});

test('public check-in displays the authorized WeChat avatar and no upload controls', () => {
  const ui = browser();
  ui.run(`state.deployment = 'public'; state.wechat = {
    ready: true, profile: { nickname: '微信昵称', avatar: 'https://thirdwx.qlogo.cn/test/132' }
  };`);
  ui.context.renderCheckin();
  assert.match(ui.app.innerHTML, /src="https:\/\/thirdwx\.qlogo\.cn\/test\/132"/);
  assert.match(ui.app.innerHTML, /name="name"[^>]*required[^>]*value=""/);
  assert.match(ui.app.innerHTML, /name="phone"[^>]*required/);
  assert.doesNotMatch(ui.app.innerHTML, /type="file"|选择头像|使用姓名头像/);
});

test('public authorization failures offer a retry without presenting a manual form', () => {
  const ui = browser();
  ui.run(`state.deployment = 'public'; window.location.search = '?wechat=denied';`);
  ui.context.renderCheckin();
  assert.match(ui.app.innerHTML, /未同意微信授权/);
  assert.match(ui.app.innerHTML, /href="\/wechat\/oauth\/start"/);
  assert.doesNotMatch(ui.app.innerHTML, /name="name"|type="file"/);
  ui.context.navigator.userAgent = 'Chrome';
  ui.context.renderCheckin();
  assert.match(ui.app.innerHTML, /请用微信扫码签到/);
  assert.doesNotMatch(ui.app.innerHTML, /href="\/wechat\/oauth\/start"/);
});

test('public check-in sends the confirmed name and phone', async () => {
  const ui = browser();
  ui.run(`state.deployment = 'public'; state.wechat.profile = { nickname: '微信昵称', avatar: 'https://thirdwx.qlogo.cn/test/132' };
    checkinUiState.name = '  王小明  '; checkinUiState.phone = '13800138000'; checkinUiState.file = {};`);
  const calls = [];
  ui.context.api = async (url, options) => {
    calls.push({ url, body: JSON.parse(JSON.stringify(options.body)) });
    return { attendee: { id: 'guest', name: '王小明', phone: '13800138000' } };
  };
  await ui.context.submitLocalCheckin({ preventDefault() {} });
  assert.deepEqual(calls, [{ url: '/api/checkin', body: { name: '王小明', phone: '13800138000' } }]);
  assert.match(ui.app.innerHTML, /签到成功/);
});
