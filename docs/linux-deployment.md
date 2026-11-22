# Linux 公网部署指南

本文以 Ubuntu 为例。Node.js 运行签到和抽奖服务，systemd 负责开机自启，Nginx 提供公网 HTTPS。来宾用微信扫码授权后，填写姓名和手机号完成签到。

- 准备一台可通过 SSH 登录、有 `sudo` 权限的 Linux 服务器，以及一个用于签到的公网域名。
- 将文中的 `checkin.example.com` 换成实际签到域名，将 `SSH_USER@SERVER_HOST` 换成实际 SSH 登录地址。项目示例安装在 `/opt/wechatsignin`。
- 将签到域名解析到服务器公网地址，并在服务器防火墙及云安全组放行 TCP `80` 和 `443`。公网模式下，Node 只监听本机的 `127.0.0.1:3100`。

## 1. 上传待部署代码

在包含待发布代码的本地仓库中执行以下命令。`git archive` 打包当前已提交的代码。迁移已有部署时，另行准备 `.env`、`data/store.json` 和 `assets/uploads/` 的备份。

```bash
git archive --format=tar.gz --output=wechatsignin.tar.gz HEAD
scp wechatsignin.tar.gz SSH_USER@SERVER_HOST:~/
ssh SSH_USER@SERVER_HOST
```

## 2. 安装 Node.js 和服务器依赖

以下命令在服务器上执行。使用 Ubuntu 的软件包安装 Nginx 和 Certbot。[Ubuntu 的 Certbot Nginx 插件](https://packages.ubuntu.com/noble/python3-certbot-nginx)

```bash
sudo apt update
sudo apt install -y curl xz-utils nginx certbot python3-certbot-nginx
```

下面的命令根据服务器架构下载 Node.js 24 LTS，校验文件后安装到 `/opt/node24`。如果服务器已有 Node.js 24 LTS，可直接使用现有安装，并在后续命令和 systemd 服务文件中使用对应的路径。[Node.js 24 官方下载目录](https://nodejs.org/dist/latest-v24.x/)

```bash
(
  set -eu
  case "$(uname -m)" in
    x86_64) node_arch=x64 ;;
    aarch64) node_arch=arm64 ;;
    *) echo '请按服务器架构安装 Node.js 24 LTS' >&2; exit 1 ;;
  esac

  cd "$(mktemp -d)"
  node_dist=https://nodejs.org/dist/latest-v24.x
  curl -fsSLO "$node_dist/SHASUMS256.txt"
  node_file=$(awk -v arch="$node_arch" '$2 ~ ("-linux-" arch "[.]tar[.]xz$") { print $2; exit }' SHASUMS256.txt)
  test -n "$node_file"
  curl -fsSLO "$node_dist/$node_file"
  sha256sum --ignore-missing -c SHASUMS256.txt
  sudo install -d -m 0755 /opt/node24
  sudo tar -xJf "$node_file" -C /opt/node24 --strip-components=1
)

export PATH="/opt/node24/bin:$PATH"
node --version
```

## 3. 安装项目并填写配置

首次部署时，在临时目录解压代码并安装 npm 依赖，再复制到服务目录。

```bash
(
  set -eu
  umask 022
  cd "$(mktemp -d)"
  tar -xzf "$HOME/wechatsignin.tar.gz"
  npm ci --omit=dev
  sudo install -d -m 0755 /opt/wechatsignin
  sudo cp -R . /opt/wechatsignin/
)
```

首次部署时创建专用服务账号，授予它 `data/` 和 `assets/uploads/` 的写入权限。命令会在 `.env` 缺失时复制配置模板。已有 `.env` 时，通过编辑合并所需配置。

```bash
cd /opt/wechatsignin
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin wechatsignin
sudo chown -R wechatsignin:wechatsignin data assets/uploads
if ! sudo test -e .env; then
  sudo install -m 0640 -o root -g wechatsignin deploy/iis/public.env.example .env
fi
sudoedit /opt/wechatsignin/.env
```

把 `PUBLIC_URL` 设为实际的 HTTPS 地址，填写三个不同的 16–80 字符管理密码，以及有 `snsapi_userinfo` 网页授权权限的公众号凭据。管理密码和 AppSecret 只保存在服务器的 `.env` 中。[公网配置模板](../deploy/iis/public.env.example)

```dotenv
PUBLIC_DEPLOYMENT=1
PUBLIC_URL=https://checkin.example.com
PORT=3100
ADMIN_PASSWORD=
SCREEN_PASSWORD=
SETTINGS_PASSWORD=
WECHAT_APP_ID=
WECHAT_APP_SECRET=
```

可分别执行三次下面的命令，生成后台、大屏和大屏设置密码。公众号凭据可以在配置域名时补齐，保存后重启服务。

```bash
node -p "require('node:crypto').randomBytes(24).toString('base64url')"
```

## 4. 设置服务开机启动

用 `sudoedit /etc/systemd/system/wechatsignin.service` 创建服务文件。若更改了安装目录或 Node.js 路径，同步修改 `WorkingDirectory` 和 `ExecStart`。[systemd 服务配置](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)

```ini
[Unit]
Description=WeChat Check-in and Lottery
After=network.target

[Service]
User=wechatsignin
Group=wechatsignin
WorkingDirectory=/opt/wechatsignin
ExecStart=/opt/node24/bin/node /opt/wechatsignin/src/server.js
Restart=on-failure
RestartSec=3
UMask=0027

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wechatsignin
curl -fsS http://127.0.0.1:3100/api/state
```

返回的 JSON 应包含 `"deployment":"public"`，`checkinUrl` 应为配置的 HTTPS 域名加 `/checkin`。启动失败时，用 `sudo journalctl -u wechatsignin -n 50 --no-pager` 查看日志。

## 5. 配置 Nginx 和 HTTPS

用 `sudoedit /etc/nginx/sites-available/wechatsignin` 创建站点配置，替换 `server_name`。已有同域名站点时，将校验文件和反向代理规则合并到现有站点，并将 `map` 放在 `http` 配置块中。WebSocket 转发用于大屏实时更新。[Nginx WebSocket 配置](https://nginx.org/en/docs/http/websocket.html)

```nginx
map $http_upgrade $wechatsignin_connection {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name checkin.example.com;

    client_max_body_size 31m;

    location ~ ^/MP_verify_[A-Za-z0-9_-]+\.txt$ {
        root /var/www/wechatsignin;
        default_type text/plain;
        try_files $uri =404;
    }

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $wechatsignin_connection;
    }
}
```

新建站点时创建软链接，然后检查配置、启动 Nginx 并申请证书。`--redirect` 将 HTTP 请求跳转到 HTTPS。[Certbot Nginx 插件用法](https://eff-certbot.readthedocs.io/en/stable/using.html#nginx)

```bash
sudo install -d -m 0755 /var/www/wechatsignin
sudo ln -s /etc/nginx/sites-available/wechatsignin /etc/nginx/sites-enabled/wechatsignin
sudo nginx -t && sudo systemctl enable --now nginx && sudo systemctl reload nginx
sudo certbot --nginx --redirect -d checkin.example.com
sudo certbot renew --dry-run

curl -fsS https://checkin.example.com/api/state
```

## 6. 配置公众号网页授权

1. 进入微信公众平台「设置与开发 → 公众号设置 → 功能设置 → 网页授权域名」，填写签到域名，例如 `checkin.example.com`。域名字段只填写主机名。
2. 将平台提供的 `MP_verify_*.txt` 原样放到 `/var/www/wechatsignin/`，让 Nginx 可以读取。确认用 `https://checkin.example.com/实际文件名.txt` 可以访问文件原文，再在微信公众平台保存。
3. 应用的回调地址为 `https://checkin.example.com/wechat/oauth/callback`。如果补填或更改了公众号凭据，执行 `sudo systemctl restart wechatsignin`。[公众号网页授权说明](https://docs.cloudbase.net/integration/wechat-official-oauth)

## 7. 验收与更新

- 访问 `/screen/checkin` 并登录大屏。用关闭 Wi-Fi 的手机在微信中扫码，确认授权后能填写姓名和手机号，提交后实时上墙。
- 登录 `/admin` 查看签到记录并试用 Excel 导出。在 `/screen/lottery` 验证抽奖，在 `/screen/settings` 用独立密码验证大屏设置。
- 遇到 `502`，先检查 systemd 服务状态及 `127.0.0.1:3100/api/state`。微信授权失败时，核对网页授权域名、校验文件和公众号凭据。大屏未实时更新时，检查 Nginx 的 `/socket.io/` 转发和 WebSocket 升级请求。
- 更新前停止服务并备份 `.env`、`data/store.json` 和 `assets/uploads/`。更新代码和 npm 依赖后，保留上述配置与数据、确认服务账号仍有写入权限，再启动服务并重复验收。
