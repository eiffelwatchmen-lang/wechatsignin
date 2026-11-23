# Windows 公网部署

来宾用微信扫码打开 [签到页](https://qd.kaigao.com/checkin)，同意公众号网页授权后自动获取微信头像和昵称，再填写姓名和手机号完成签到。没有微信头像时自动使用姓名头像。HTTPS 代理将请求转发到 Windows 本机的 Node 服务 `127.0.0.1:3100`，不对公网开放 3100 端口。

## 1. 启动 Node 服务

1. 在 Windows 安装 [Node.js 24 LTS](https://nodejs.org/en/download)。将更新后的项目解压到 `C:\Apps\WechatSignIn`，放在 IIS 站点目录之外。
2. 新部署时将 [public.env.example](../deploy/iis/public.env.example) 作为项目根目录的 `.env`。已有 `.env` 时合并配置，保留备份。后台、大屏和大屏设置各用不同的 12 至 80 字符密码，建议使用至少 16 字符随机密码。已有部署可先升级服务，再填入 `SETTINGS_PASSWORD` 并重启以启用设置页。

```dotenv
PUBLIC_DEPLOYMENT=1
PUBLIC_URL=https://qd.kaigao.com
PORT=3100
ADMIN_PASSWORD=
SCREEN_PASSWORD=
SETTINGS_PASSWORD=
WECHAT_APP_ID=
WECHAT_APP_SECRET=
```

在服务器上运行以下命令三次生成密码。密码和公众号 AppSecret 只保存在服务器的 `.env`，不提交到 GitHub。微信参数未填时，后台仍可登录，来宾页显示「微信签到暂未开放」。

```powershell
node -p "require('node:crypto').randomBytes(24).toString('base64url')"
```

3. 在 PowerShell 启动项目：

```powershell
Set-Location C:\Apps\WechatSignIn
npm.cmd ci --omit=dev
npm.cmd start
```

看到「公网部署模式」后，在另一个窗口执行 `curl.exe http://127.0.0.1:3100/api/state`。返回应包含 `"deployment":"public"` 和 HTTPS 签到链接，未登录时人员、奖项和中奖列表为空。

## 2. 接入现有 HTTPS 站点

`qd.kaigao.com` 已指向部署服务器时保留 DNS。先确认谁在处理该域名的 HTTPS；如果已有 IIS 站点，备份配置后只修改这个站点，不改变其他域名的绑定。若 HTTPS 由其他代理处理，在原代理上设置相同的上游，不再新建冲突的 443 绑定。中国内地服务器上线前向接入商确认[备案与接入状态](https://help.aliyun.com/zh/icp-filing/basic-icp-service/support/for-the-record-domain-faq/)。

1. IIS 安装 URL Rewrite、Application Request Routing（ARR）及 [WebSocket Protocol](https://learn.microsoft.com/en-us/iis/configuration/system.webserver/websocket)。按 [Microsoft 的 ARR 指南](https://learn.microsoft.com/en-us/iis/extensions/url-rewrite-module/reverse-proxy-with-url-rewrite-v2-and-application-request-routing)启用 **Enable Proxy**。保持真实客户端地址转发（ARR 在 `X-Forwarded-For` 右侧追加客户端地址），不缓存应用响应。
2. 确认站点的 [HTTPS 绑定](https://learn.microsoft.com/en-us/iis/configuration/system.applicationHost/sites/site/bindings/binding)为 `qd.kaigao.com:443`，证书覆盖该域名。使用单独的站点目录，例如 `C:\inetpub\qd-checkin`。将 [web.config](../deploy/iis/web.config) 放在这个目录；已有规则时由管理员合并，避免覆盖其他业务。公众号域名校验文件由 IIS 直接提供，其他路径及查询参数（含 `/socket.io/`）转发给 Node。
3. Windows 防火墙和云安全组保留 HTTPS 的 443 入站规则，不增加 3100 入站规则。若有 80 端口入口，按现有站点规则跳转到 HTTPS。

## 3. 配置公众号网页授权

1. 在 [微信公众平台](https://mp.weixin.qq.com/) 确认公众号具备 `snsapi_userinfo` 网页授权权限。将该公众号的 AppID、AppSecret 填入服务器 `.env` 中的 `WECHAT_APP_ID`、`WECHAT_APP_SECRET` 后重启 Node。不要使用小程序的 AppID，也不要在聊天或截图中发送 AppSecret。
2. 进入公众号的「设置与开发 → 公众号设置 → 功能设置 → 网页授权域名」，填 `qd.kaigao.com`（不带 `https://`、端口或路径）。按页面提示下载 `MP_verify_*.txt`，原样放在 IIS 站点根目录，与 `web.config` 同级。开启 IIS 静态内容功能，确认通过 `https://qd.kaigao.com/文件名.txt` 能读取原文后，在微信后台保存设置。[腾讯云开发接入说明](https://docs.cloudbase.net/integration/wechat-official-oauth)
3. 应用回调地址为 `https://qd.kaigao.com/wechat/oauth/callback`。若不是 IIS，由现有代理直接提供校验文件，其余路径照常转发给 Node。

## 4. 验收与常驻运行

- 手机关闭 Wi-Fi，用微信扫描签到大屏二维码。授权后应出现微信头像、姓名和手机号输入框。填齐两项后签到应实时上墙，同一个微信账号再次扫码会识别已有记录。后台可查询和导出手机号，大屏名单隐藏手机号。
- 打开 [后台](https://qd.kaigao.com/admin)、[签到大屏](https://qd.kaigao.com/screen/checkin)与[抽奖大屏](https://qd.kaigao.com/screen/lottery)。登录后确认新签到头像旋转入场、抽奖正常。后台可以导出 Excel。
- 用 `SETTINGS_PASSWORD` 登录 [大屏设置](https://qd.kaigao.com/screen/settings)，保存头像墙、Logo 或二维码布局后确认大屏已同步。大屏密码用于操作抽奖，后台密码用于管理奖项和数据。未登录访问 `/api/attendees` 应返回 `401`。
- 在后台「抽奖设置」中确认新签到只进入待选名单。选人并点击「添加内定」后，才会出现在对应奖项的内定名单中。点击「删除」可取消当前奖项的内定资格，签到记录会保留。
- 验收完成后用 Windows 任务计划程序设为系统启动时运行：程序为 `node.exe` 的完整路径，参数为 `src\server.js`，起始目录为 `C:\Apps\WechatSignIn`。使用专用低权限账户，授予项目读取权限，以及 `data` 和 `assets\uploads` 的写入权限。配置任务失败后重启；先关闭手动启动的实例，再启动计划任务。
- 更新前停止服务，备份 `.env`、`data\store.json` 和 `assets\uploads`。公网密码通过 `.env` 更换，重启后工作人员需重新登录，来宾需重新授权。旧版内网记录可迁移，但不会与微信身份自动合并。

**排查：** 后台「签到管理」点击「开始签到」可开放签到。「微信授权未配置」或 `/api/state` 返回 `wechat.ready=false` 时，需要在服务器 `.env` 填入 `WECHAT_APP_ID` 和 `WECHAT_APP_SECRET` 后重启 Node，不是签到开关的问题。`404` 先看站点绑定和重写规则；`502` 先检查 Node 是否监听 3100；授权失败先核对域名、公众号权限和 AppID 是否匹配；不实时更新时检查 `/socket.io/` 转发、WebSocket 和代理缓存。
