const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  if (url.hostname !== 'api.weixin.qq.com') return originalFetch(input, options);
  const params = url.searchParams;
  if (url.pathname === '/sns/oauth2/access_token') {
    if (params.get('appid') !== process.env.WECHAT_APP_ID || params.get('secret') !== process.env.WECHAT_APP_SECRET
        || params.get('grant_type') !== 'authorization_code' || params.get('code') === 'invalid') {
      return Response.json({ errcode: 40029, errmsg: 'invalid code' });
    }
    const code = params.get('code');
    return Response.json({
      access_token: `test-token-${code}`,
      openid: ['second', 'no-avatar'].includes(code) ? 'test-openid-two' : 'test-openid-one',
      scope: code === 'base-only' ? 'snsapi_base' : 'snsapi_userinfo'
    });
  }
  if (url.pathname === '/sns/userinfo') {
    const accessToken = params.get('access_token');
    return Response.json({
      openid: accessToken === 'test-token-mismatch' ? 'different-openid' : params.get('openid'),
      nickname: '微信测试昵称',
      headimgurl: accessToken === 'test-token-no-avatar' ? '' : 'http://thirdwx.qlogo.cn/mmopen/test-avatar/132'
    });
  }
  return Response.json({ errcode: 404 });
};
