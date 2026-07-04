# handmux

**[handmux.com](https://handmux.com)** · *[English → README.md](README.md)*

[![npm](https://img.shields.io/npm/v/handmux?color=cb3837&logo=npm)](https://www.npmjs.com/package/handmux) [![CI](https://github.com/yuanyuanzijin/handmux/actions/workflows/test.yml/badge.svg)](https://github.com/yuanyuanzijin/handmux/actions/workflows/test.yml) [![license: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE) [![node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)

> **指挥Agent干活,何必守在电脑前?** 把创造力随时握在手里——电脑上跑一行命令、手机扫码连上,
> 那个正跑着的终端连同 Claude 就在你手里了。

handmux 把你电脑上那个**正跑着的 tmux 会话**原样搬进手机浏览器——**同一个、真实的 pane,不是只读
镜像**。直接在手机上新建一个会话,或接手工位上已经在跑的那个——然后窝在沙发上、挤地铁时、排队买咖啡时接着盯它跑。进程不停,你只是换了块屏。
**手机端零安装——点开链接就进去了**;还能"添加到主屏",作为 PWA 全屏运行,体验和原生 App 基本一致。任意 shell / TUI 都能开,跟 **Claude Code** 配合最深:哪个 pane
要你拍板,第一时间推到手机上,拇指点一下就批。

<p align="center">
  <img src="assets/handmux-run.gif" alt="handmux:说出需求,Claude Code 写好,点文件名即可预览结果" width="280">
  &nbsp;&nbsp;
  <img src="assets/handmux-doc.gif" alt="handmux:需要你时推送提醒,查看 git 仓库和每个 agent 的用量" width="280">
  <br>
  <em>真实手机浏览器、真实 pane——左:说出需求,Claude Code 直接写好,点文件名即可预览;右:需要你时推送提醒,查看 git 仓库与各 agent 用量。</em>
</p>

## 为什么是 handmux

- **🚀 一条命令就上线。** `handmux start`,扫码,完事。不用注册、不上应用商店、不用旁加载原生 App,
  就是一个手机浏览器能点开的链接。
- **🧶 你真实的会话,装进口袋。** 不是新开个 shell、也不是截图——是你电脑上**那一个** tmux pane,agent
  照跑。工位 → 手机 → 工位,全程同一个会话。
- **🤖 为「跟 agent 一起 vibe 编程」而生。** 跟 Claude Code 最深:要你时立刻推送、收件箱标好哪个 pane
  「进行中 / 等你 / 已完成」、批计划批授权点一下就过。Codex、aider、任意 shell/TUI 也都行。

## 2 分钟零门槛上手

**电脑上**需要两样东西(手机只要个浏览器)。如果你本来就泡在 tmux 里,基本已经齐了:

```bash
node -v     # 需要 Node ≥ 18    —— 没有就去 https://nodejs.org
tmux -V     # 需要 tmux ≥ 3.0   —— `brew install tmux` / `apt install tmux`
```

然后装上、跑起来:

```bash
npm i -g handmux     # 装一次
handmux start        # 跑起来 —— 仅本机 / 同 wifi,不对外暴露
```

`start` 会打印一个**二维码**(外加地址和 token)。**手机扫二维码**——token 在二维码里,首次打开即登录。
就这样:你会看到自己真实的 tmux 会话,点一个,就开始操作了。

想从**任何地方**(不只同一 wifi)都连得上?加一个参数就开一条免费公网 HTTPS 链接:

```bash
handmux start --tunnel cloudflare   # 即时公网地址(自动装 cloudflared)
handmux setup                       # 或一次性配好隧道 + 名称 + 通知,落盘
```

```
  tunnel   cloudflare   ·   pid 21352
  🌐 open   https://elementary-incidents.trycloudflare.com/
  💻 local  http://localhost:19999/
  🔑 token  aicbHOGW…
```

打印出来的明文链接不带 token,可安全截图/分享。只有**二维码**带 token;`🔑 token` 那行就是你的密码——
开明文链接时把它粘进去就能登录。

### Windows 用户?装进 WSL2

handmux 靠 **tmux** 驱动,而 tmux 只有 Unix 版、没有原生 Windows 版。装进 **WSL2**(真正的 Linux 内核
+ 真 tmux),上面的一切原样适用:

```powershell
wsl --install     # 一次性,在 PowerShell(管理员)里:装好 WSL2 + Ubuntu,然后重启
```

然后打开 Ubuntu 终端,按上面的步骤来(`apt install tmux`、装 Node、`npm i -g handmux`)。两点 WSL 专属提醒:

- **务必走隧道。** WSL2 是带独立 IP 的 NAT 虚拟机,同 wifi 的局域网地址手机连不到。直接用
  `handmux start --tunnel cloudflare`,公网链接不受影响。
- **自启需要 systemd。** `handmux service` 依赖 systemd;在 `/etc/wsl.conf` 里加 `[boot]` /
  `systemd=true` 再 `wsl --shutdown` 启用一次即可。不启用的话,开个终端跑 `handmux start` 并保持窗口即可。

## 功能

不止是个远程 shell——是给终端和你的编码 agent 配的一整个**手机驾驶舱**。

**围绕 Claude Code 打造**

- **需要你,就推给你**——某个 pane 弹了授权、要你批计划、或者干完了,那一刻就推一条到手机,标签页关着照样收得到。
- **Agent 收件箱**——每个 Claude pane 标好「进行中 / 等你 / 已完成」,哪个卡住点一下直接过去。
- **拇指点一下就批**——授权、批计划直接在手机上点;手机敲的就是真实按键,点一下等于在键盘上敲了一下。
- **语音输入**——下一条 prompt 张嘴就说,不用打字(可选,需自备讯飞 key)。

**真·驾驶舱,装进手机**

- **Git 查看器**——像 VS Code 那样:改动、提交记录、随便哪个分支、全屏彩色 diff、多仓库分页。只读,绝不动你的工作区。
- **站点预览**——挑个目录预览静态站,或填端口预览正跑着的服务,路由/接口/HMR 全保留;手机、电脑视图随你切。
- **文档**——终端里的路径点一下就打开;Markdown 排版、字号缩放、一句句高亮念出来。
- **文件随手传**——聊天框多选上传(自动填好路径)、下载要确认、系统分享进来、绝对路径随手复制。
- **想法和命令**——每个窗口一份待办(能语音记、一点填入)+ 命令面板(常用/最近 + 斜杠命令 `/compact`、`/model`、`/loop`…)。
- **图片查看**——捏合缩放、保存/分享、内嵌 GIF。

**在手机上够稳**

- 真实 tmux pane,任何 TUI、shell、agent 都行,不是只读镜像。
- 断线自动退避重连、掉线有横幅、离线有兜底页、切到后台就暂停轮询。
- 光标不乱跳、长按拖动选中复制、按键区长按连发、键盘自动抬起来。
- 零安装——手机浏览器直接跑;愿意的话"加到主屏"就成了 PWA。双语(English / 中文)。

## 进去之后

- 你会看到自己真实的 tmux 会话——点一个进入。终端里直接打字;用屏幕上的按键条按方向键 /
  Ctrl / Tab / Esc,顶栏切换会话、窗口、pane。
- **添加到主屏幕**(Safari/Chrome 分享菜单),即可像 App 一样全屏运行。
- 画面能扛弱网——失败时保留上一帧好画面,连续失败显示"连接丢失"横幅,标签页隐藏时自动暂停。

## 命令

```
handmux start [flags]                 后台启动服务(+ 隧道)
handmux setup                         配置隧道 / 名称 / 通知(写入配置;重跑即修改)
handmux stop                          全部停止
handmux restart
handmux status                        查看状态 + 当前访问地址
handmux logs [--follow] [--lines N]   查看 supervisor 日志
handmux config                        打印生效配置 + 每个值的来源
handmux hooks install|uninstall       开启 / 关闭 Claude Code 通知(收件箱)
handmux service install [start-flags] 登录时自启(launchd / systemd --user)
handmux service uninstall             移除自启项
handmux --version                     打印版本号
```

**整个配置就两道门:** `handmux start` 直接跑(不需要配置——默认仅局域网、自动生成 token、出二维码),
`handmux setup` 是**唯一**的持久化配置入口。要改任何东西,重跑 `setup`。就这么简单;下面都是细节。

### Claude Code 通知(收件箱)

Agent 收件箱和「需要你就推给你」靠的是 Claude Code 的生命周期 hook。它**默认不开、需你显式开启**——
`handmux hooks install` 会把一个很小的通知脚本拷进 `~/.claude/hooks/`,并往 `~/.claude/settings.json`
注册六个 hook 事件(幂等;不动你自己的 hook)。`handmux setup` 也会问一句,首次在手机上打开收件箱时
还能一键开启。`handmux hooks uninstall` 移除它。不用 Claude Code 的话直接跳过——绝不碰 `~/.claude`。

### start 参数

参数只对**这一次运行**覆盖配置文件、绝不落盘——适合不动已存配置就快速试一下
(`handmux start --tunnel cloudflare`)。要永久生效,用 `handmux setup`。

```
--tunnel none|cloudflare|cloudflare-named|ssh   如何对外暴露(默认 none —— 仅本机/局域网)
--port N                   服务端口(默认 19999)
--host H                   绑定地址(默认 0.0.0.0)
--token S                  鉴权 token(默认自动生成并打印)
--name "My Box"            浏览器标签页 + 主屏幕图标显示的应用名
--preview-domain D         开启端口动态预览(需要通配子域名)
--config PATH              改用指定配置文件,而非 ~/.handmux/config.json(开发 / 多套配置)
--foreground, -f           前台运行,不守护
--no-qr                    不渲染二维码

# ssh 隧道(--tunnel ssh):
--ssh-host user@host[:port]   反向转发到的服务器(tunlite)
--remote-port N               在该服务器上绑定的端口(默认同 --port)
--ssh-jump user@host[,…]      可选的跳板/堡垒机
--public-url URL              对外公布的地址(默认 http://<host>:<remote-port>)
# cloudflare-named(--tunnel cloudflare-named):
--cf-hostname H               你的 Cloudflare 域名(如 handmux.example.com)
--cf-tunnel-name N            命名隧道的名字(默认 handmux)
```

### 配置

就**两层**,这就是全部模型:

- **配置文件**是这台机器的持久设置(隧道、token、推送/语音密钥)。位置只有一个——
  `~/.handmux/config.json`,由 `handmux setup` 写入。用 `--config PATH` 可指向别的文件(比如 `dev.json` /
  `prod.json` 并存、按需选)。**不合并、不继承**:最多只读一个文件。
- **参数**只对**这一次运行**覆盖单项,绝不写回。

单项优先级:**参数 > 配置文件 > 内置默认。** 启动时会打印加载了哪个文件(`config: …`);`handmux config`
则逐项打印每个设置**解析成什么值、来自哪里**(参数 / 文件 / 环境 / 默认),flag 和文件谁赢一目了然。

通常你不用手改文件——`handmux setup` 替你写(重跑即修改)。真要手改也行,就是普通 JSON;可选功能写进
**同一个文件**(不再有单独的 `.env`):

```jsonc
{
  "tunnel": "none",              // none | cloudflare | cloudflare-named | ssh
  "port": 19999, "host": "0.0.0.0",
  "name": "My Box",              // 浏览器标签 / 主屏图标名;省略 → 默认
  "token": "…",                  // 留空 → 首次启动自动生成
  "previewDomain": "preview.example.com",
  "vapid": { "public": "…", "private": "…", "subject": "mailto:you@example.com" },  // 推送
  "xfyun": { "appId": "…", "apiKey": "…", "apiSecret": "…" }                        // 语音
  // ssh 隧道追加:"sshHost"、"remotePort"、"sshJump"、"publicUrl"
  // cloudflare-named 追加:"cfHostname"、"cfTunnelName"
}
```

文件以 `0600` 写入(含 token 和推送/语音密钥)。

## 联网:两条路

| 方式 | 中转/边缘 | TLS / 域名 | 适合 |
|------|----------|-----------|------|
| **cloudflare** | Cloudflare 全球边缘(免费快速隧道) | 自动,随机 `*.trycloudflare.com` | 快速尝鲜、零配置 |
| **自建(ssh)** | *你自己的 VPS* | 你的域名 + 证书(推荐 Caddy 自动 HTTPS) | 稳定访问、自有域名、Cloudflare 不稳的地区 |

> 自建(ssh)隧道(引擎:[`tunlite run`](https://www.npmjs.com/package/tunlite),已打包)现已可用——
> 运行 `handmux setup`(或 `--tunnel ssh --ssh-host user@host`)。`cloudflare-named` 隧道(在你自己的
> Cloudflare 域名上获得稳定 HTTPS)也用同样方式开启。

### 自建 ssh 隧道:服务端反向代理

`tunlite` 把你的本地端口反向转发到你自己的服务器(默认绑在 `127.0.0.1:<remote-port>`——
在你给它加反向代理之前,不会暴露到公网)。

**nginx(已有安装):**

```nginx
server {
  server_name handmux.example.com;
  client_max_body_size 60m;            # 防止手机上传时报「文件过大」
  location / {
    proxy_pass http://127.0.0.1:19999; # = handmux --remote-port
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 90s;            # 容忍长轮询
  }
}
# 用 certbot 配 TLS;再加一条 A 记录把域名指向这台服务器。
```

**没有 nginx——Caddy(自动 Let's Encrypt,两行):**

```caddy
handmux.example.com {
  reverse_proxy 127.0.0.1:19999
}
```

不需要 TLS?把 tunlite 绑到 `0.0.0.0`、在 sshd 里设 `GatewayPorts yes`,然后直接用
`http://<host>:<remote-port>` 访问(明文不加密)。

## 开机自启

```bash
handmux service install --tunnel cloudflare   # 重启/登录后自动回来
```

macOS 用 launchd LaunchAgent;Linux 用 `systemd --user` unit(未登录也要自启:
`loginctl enable-linger "$USER"`)。服务装着时,`handmux stop` 只是临时(系统会重新拉起)
——要彻底停用 `service uninstall`。

## 安全

用隧道时访问地址是公开的,所以**始终要求 token**(不传 `--token` 会自动生成一个)。打印出来的
明文链接不带 token、可安全分享;**把 token(以及带 token 的二维码)当密码对待。**

发现安全问题?请私下报告——见 [SECURITY.md](SECURITY.md),别开公开 issue。

## 语音输入(可选)

点麦克风可把语音听写进输入框,底层用[讯飞](https://www.xfyun.cn/),**需要你自己填 key 才会开启**——
在讯飞控制台开通「语音听写 (IAT)」应用,往配置文件里加一段
`"xfyun": { "appId": "…", "apiKey": "…", "apiSecret": "…" }`(见《配置》)。密钥只留在服务端,
手机只拿到一个短时效的签名地址。没配 key 时,麦克风按钮直接不显示。

## 推送通知(可选)

「pane 需要你 / 跑完时推手机」这条**需要你自己配一对 VAPID 密钥**(标准 Web Push 凭证)才开启。
用自带的 `web-push` 生成:

```bash
npx web-push generate-vapid-keys
```

往配置文件里加一段 `"vapid": { "public": "…", "private": "…", "subject": "mailto:you@example.com" }`
(见《配置》)。两者齐全时 `/api/push/vapid` 才发公钥、手机才能订阅;缺则该接口返回 503、铃铛隐藏。
推送还依赖 Claude Code hook(pane 得先有状态可推)——见上面《Claude Code 通知》。

## 端口动态预览(进阶)

设置 `--preview-domain`(或配置里的 `"previewDomain"`)可把本机其他开发服务(如 `:3000` 上的
Vite)透给手机,每个走自己的子域名。这需要一个指向网关的**通配子域名**(`*.your.domain`),所以
只在自建路上可用,快速隧道用不了。`handmux setup` **不会**替你接好这一步——自己配好再把
`previewDomain` 指过去。

**证书层级(Cloudflare)**:浏览器是用 HTTPS 访问预览的,通配子域名得有证书。Cloudflare 免费的
Universal SSL 只覆盖**一级**——`*.example.com` 可用(预览走 `<端口>.example.com`),但更深的
`*.preview.example.com` 需要**高级证书(Advanced Certificate Manager)**。所以要么把预览保持在
一级,要么开 ACM。(走 ssh / 自有边缘时由你自己提供通配证书,如 Let's Encrypt 的
`*.preview.your.domain`。)

## 许可证

AGPL-3.0
