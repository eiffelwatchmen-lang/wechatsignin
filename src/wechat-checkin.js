import { createHash, randomBytes } from 'node:crypto';
import { readToken } from './public-access.js';

const challengeCookie = '__Host-checkin-oauth';
const profileCookie = '__Host-checkin-wechat';
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' };
const challengeLifetime = 5 * 60 * 1000;
const profileLifetime = 12 * 60 * 60 * 1000;
const newToken = () => randomBytes(32).toString('hex');

function avatarUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port
        || !/(^|\.)(qlogo\.cn|qpic\.cn)$/.test(url.hostname) || url.href.length > 1000) return '';
    url.protocol = 'https:';
    return url.href;
  } catch {
    return '';
  }
}

export function createWechatCheckin({ origin, env, fetchJson }) {
  const appId = env.WECHAT_APP_ID?.trim();
  const secret = env.WECHAT_APP_SECRET?.trim();
  const ready = Boolean(appId && secret);
  const challenges = new Map();
  const profiles = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [id, challenge] of challenges) if (challenge.expiresAt <= now) challenges.delete(id);
    for (const [id, profile] of profiles) if (profile.expiresAt <= now) profiles.delete(id);
  }, 60_000).unref();

  return {
    ready,
    profile(req) {
      const profile = profiles.get(readToken(req, profileCookie));
      return profile?.expiresAt > Date.now() ? profile : null;
    },
    start(req, res) {
      res.set('Cache-Control', 'no-store');
      if (!ready) return res.redirect('/checkin?wechat=not-ready');
      challenges.delete(readToken(req, challengeCookie));
      if (challenges.size >= 10_000) return res.redirect('/checkin?wechat=failed');
      const state = newToken();
      const challenge = newToken();
      challenges.set(challenge, { state, expiresAt: Date.now() + challengeLifetime });
      // The state cookie must be available on WeChat's top-level redirect back.
      res.cookie(challengeCookie, challenge, { ...cookieOptions, maxAge: challengeLifetime });
      const params = new URLSearchParams({
        appid: appId,
        redirect_uri: `${origin}/wechat/oauth/callback`,
        response_type: 'code',
        scope: 'snsapi_userinfo',
        state
      });
      res.redirect(`https://open.weixin.qq.com/connect/oauth2/authorize?${params}#wechat_redirect`);
    },
    async callback(req, res) {
      res.set('Cache-Control', 'no-store');
      const { code, state } = req.query;
      const challenge = readToken(req, challengeCookie);
      const pending = challenges.get(challenge);
      if (!ready || !pending || state !== pending.state || pending.expiresAt <= Date.now()) {
        return res.redirect('/checkin?wechat=failed');
      }
      challenges.delete(challenge);
      res.clearCookie(challengeCookie, cookieOptions);
      if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(code) || code === 'authdeny') {
        return res.redirect('/checkin?wechat=denied');
      }
      try {
        const tokenParams = new URLSearchParams({
          appid: appId, secret, code, grant_type: 'authorization_code'
        });
        const credentials = await fetchJson(`https://api.weixin.qq.com/sns/oauth2/access_token?${tokenParams}`);
        const { openid, access_token: accessToken, scope } = credentials;
        if (typeof openid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(openid)
            || typeof accessToken !== 'string' || !accessToken || !String(scope).split(',').includes('snsapi_userinfo')) {
          throw new Error('Invalid authorization');
        }
        const userParams = new URLSearchParams({ access_token: accessToken, openid, lang: 'zh_CN' });
        const user = await fetchJson(`https://api.weixin.qq.com/sns/userinfo?${userParams}`);
        if (user.openid !== openid) throw new Error('Mismatched WeChat identity');

        const previous = readToken(req, profileCookie);
        if (profiles.size >= 10_000 && !profiles.has(previous)) return res.redirect('/checkin?wechat=failed');
        profiles.delete(previous);
        const session = newToken();
        profiles.set(session, {
          id: `wechat-${createHash('sha256').update(`${appId}:${openid}`).digest('hex')}`,
          openid,
          nickname: typeof user.nickname === 'string' ? user.nickname.trim().slice(0, 60) : '',
          avatar: avatarUrl(user.headimgurl),
          expiresAt: Date.now() + profileLifetime
        });
        res.cookie(profileCookie, session, { ...cookieOptions, maxAge: profileLifetime });
        return res.redirect('/checkin?wechat=authorized');
      } catch {
        return res.redirect('/checkin?wechat=failed');
      }
    }
  };
}
