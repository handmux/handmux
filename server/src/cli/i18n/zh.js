// 中文字典。键与 en.js 一一对应;缺键会自动回退到英文。命令名、flag、隧道名等字面量保持英文(它们是要照抄输入的)。
export default {
  // 通用
  'err.generic': '✗ {msg}',
  'err.configNotFound': '✗ --config {path}:找不到该文件',
  'err.badConfig': '✗ 配置有误 {path}:{msg}',
  'err.namedNotProvisioned': '✗ 命名隧道尚未配置 —— 请先运行 `handmux setup`',

  // start / service install 顶部打印的配置来源
  'config.loaded': '配置:{path}',
  'config.none': '(无 —— 使用 flag + 默认值)',

  // ssh 预检
  'ssh.confirmSetup': '到 {host} 的免密 SSH 还没配置。现在配置吗?',
  'ssh.notSetup': '免密 SSH 未配置 —— 请运行:{bin} setup-key {host}',

  // tmux 是否存在 / 版本
  'tmux.notFound': '✗ 未找到 tmux。',
  'tmux.explain1': '  handmux 跑在 tmux(终端复用器)之上 —— 它从手机驱动你真实的 tmux 窗格,',
  'tmux.explain2': '  所以这台机器上必须先装好 tmux。',
  'tmux.install': '  安装:  {hint}',
  'tmux.thenStart': '  然后再运行 `handmux start`。',
  'open.usage': '用法: handmux open <会话名>   接入该 tmux 会话(不存在则新建)',
  'open.insideTmux': '你已经在 tmux 里了——切换会话请用 tmux 自己的方式(如 `tmux switch-client -t <会话名>`),不要嵌套。',
  'tmux.tooOld': '⚠ tmux {raw} 低于测试过的最低版本 {min};终端渲染可能有偏差',

  // start —— 已在运行
  'start.running.same': 'handmux 已在运行 —— 直接打开下面的地址即可。',
  'start.running.changedHead': 'handmux 已在运行(隧道:{tunnel})。运行中的实例不会自动应用配置改动:',
  'start.running.changedRow': '  • {key}:{from} → {to}(你这次想要的)',
  'start.running.switchQ': '现在切换到新设置吗?(会重启 handmux)',
  'start.running.hint': "保持不变。想应用新设置时,运行 'handmux restart' 即可。",

  // start —— 启动中
  'start.overrides': '  ↳ --tunnel {flag} 仅本次覆盖配置文件里的 {file}',
  'start.foreground': '正在启动 handmux(隧道:{tunnel},端口:{port})—— 按 Ctrl-C 停止',
  'start.starting': '正在启动 handmux(隧道:{tunnel},端口:{port})…',

  // stop / status
  'stop.notRunning': 'handmux 未在运行',
  'stop.stopped': '已停止 handmux(pid {pid})',
  'status.stopped': '● handmux 已停止',
  'status.running': '● handmux 运行中',

  // logs
  'logs.none': '(还没有日志 —— 先运行 handmux start)',

  // update
  'update.available': '  ⬆  handmux {latest} 可升级(当前 {current})',
  'update.how': '     升级:  handmux update  (或 npm i -g handmux@latest)',
  'update.running': '正在升级 handmux(npm i -g handmux@latest)…',
  'update.done': '✓ handmux 已更新。',
  'update.restartHint': '  运行 `handmux restart` 以启用新版本。',
  'update.failed': '✗ 升级失败。请手动运行:npm i -g {pkg}@latest(可能需要 sudo)。',

  // cloudflared 自动下载
  'cf.downloading': '  ↓ 正在下载 cloudflared({file})…',

  // natapp / cpolar 客户端二进制
  'client.downloading': '  ↓ 正在下载 {name}({file})…',
  'client.cpolarManual': '✗ cpolar 不可用 —— 到 https://www.cpolar.com/download 下载,解压出二进制放进 ~/.handmux/bin/ 后重试。',
  'client.cpolarAuthFail': '✗ cpolar 拒绝了该 authtoken —— 到 https://dashboard.cpolar.com 核对一下。',
  'client.natappManual': '✗ 未找到 natapp —— 到 https://natapp.cn 下载(需先登录,非公开下载),把 `natapp` 二进制放到 {dir}(或 PATH 上任意位置)后重试。',

  // 访问信息块(printAccess)
  'access.noState': '  (无状态)',
  'access.error': '  ✗ {msg}',
  'access.tunnel': '  隧道   {tunnel}   ·   pid {pid}',
  'access.open': '  🌐 打开   {url}',
  'access.pending': '(等待中…)',
  'access.lan': '  📶 局域网 {url}',
  'access.local': '  💻 本机   {url}',
  'access.token': '  🔑 令牌   {token}',
  'access.reachable': '  ✓ 可访问',
  'access.unreachable': '  ⚠ 隧道已起,但 {url} 没有响应 —— 检查服务端的反向代理 / DNS',
  'access.hint': '  handmux status | stop',

  // hooks
  'hooks.confirmEnable': '启用编程 agent 通知(收件箱)?',
  'hooks.installedShort': '✓ agent hooks 已安装。',
  'hooks.noClaude': '未检测到 Claude Code(缺少 ~/.claude)—— 无需安装。',
  'hooks.noAgents': '未检测到编程 agent(无 ~/.claude,且 PATH 上没有 codex)—— 无需安装。',
  'hooks.installed': '✓ Claude hooks 已安装 → ~/.claude/settings.json',
  'hooks.installedClaude': '✓ Claude Code hooks 已安装 → ~/.claude/settings.json',
  'hooks.installedCodex': '✓ Codex hooks 已安装 → ~/.codex/config.toml',
  'hooks.installedHint': '  重启或新开一个 agent 会话以加载;窗格上报后收件箱就会亮起。',
  'hooks.removed': '✓ agent hooks 已移除。',
  'hooks.usage': '用法:handmux hooks install|uninstall',

  // Claude statusLine 用量捕获(点亮手机用量页的 5h/周额度条)
  'statusline.confirmEnable': '在手机上显示 Claude 的 5h/周额度?(会安装一个 Claude statusLine)',
  'statusline.installed': '✓ Claude statusLine 已安装 → ~/.claude/settings.json',
  'statusline.reload': '  新开一个 Claude 会话以加载;用量页会随上报逐渐填上。',
  'statusline.foreignHint': '你已经有自己的 Claude statusLine —— 保持不动。想同时点亮手机用量页,把它接到我们的捕获器后面:',

  // service
  'service.usage': '用法:handmux service install [start-flags] | handmux service uninstall',
  'service.installed': "handmux 现在会开机自启。移除请运行 'handmux service uninstall'。",

  // config 命令
  'configcmd.file': '配置文件:{path}',
  'configcmd.fileNone': '(无 —— 使用默认值;运行 `handmux setup` 可创建一个)',
  'configcmd.legend': '  来源:flag(仅本次)· file · env · default',

  // setup 向导
  'setup.confirmStart': '现在启动 handmux 吗?',
  'setup.later': "准备好后运行 'handmux start' 即可。",
  'setup.needTty': 'handmux setup 需要一个交互式终端',
  'setup.langQ': 'Language / 语言',
  'setup.lang1': '  1) English',
  'setup.lang2': '  2) 中文',
  'setup.askName': '应用名称(显示在浏览器标签 / 主屏图标;留空 = 默认)',
  'setup.tunnelQ': '你的手机怎么连到这台机器?',
  'setup.tunnel1': '  1) none              —— 仅同一 Wi-Fi / 局域网',
  'setup.tunnel2': '  2) cloudflare        —— 即时、随机的临时 https 地址',
  'setup.tunnel3': '  3) cloudflare-named  —— 用你自己的域名,稳定 HTTPS(最省心)',
  'setup.tunnel4': '  4) ssh (tunlite)     —— 你自己的服务器 / 边缘',
  'setup.tunnel5': '  5) natapp            —— 国内可用的隧道(需要 natapp authtoken)',
  'setup.tunnel6': '  6) cpolar            —— 国内可用的隧道(自动安装;需要 cpolar authtoken)',
  'setup.choose': '选择 1-6',
  'setup.invalid': '无效选择',
  'setup.askPort': '服务端口',
  'setup.askHostname': '公网域名(例如 handmux.example.com)',
  'setup.askTunnelName': '隧道名称',
  'setup.askSshHost': 'ssh 主机(user@host[:port])',
  'setup.askRemotePort': 'ssh 主机上的远程端口',
  'setup.askPublicUrl': '公网地址(留空 = http://host:remotePort)',
  'setup.natappGuide': '获取 authtoken:登录 https://natapp.cn → 购买/选择一条隧道 → 复制它的 authtoken(一个 token 对应一条隧道)。',
  'setup.cpolarGuide': '获取 authtoken:登录 https://dashboard.cpolar.com → 验证/Verify → 复制你的 authtoken。',
  'setup.askAuthtoken': 'authtoken',
  'setup.askFixed': '用固定域名吗?(否 = 免费临时域名,每次重启都会变)',
  'setup.askNatappDomain': '你在 natapp 后台为该 authtoken 绑定的固定域名(例如 myapp.natapp1.cc)',
  'setup.askCpolarDomain': '你保留的二级域名或绑定的自有域名(例如 myapp.cpolar.top)',
  'setup.askCpolarRegion': 'cpolar 区域(cn = 中国大陆,国内更快;留空 = cpolar 默认)',
  'setup.natappReady': '✓ natapp 客户端就绪',
  'setup.cpolarReady': '✓ cpolar 客户端就绪',
  // setup 中枢(菜单模型)
  'setup.hubTitle': '配置哪一项',
  'setup.secConnection': '连接',
  'setup.secName': '名称',
  'setup.secPort': '端口',
  'setup.secLanguage': '语言',
  'setup.secPush': '推送',
  'setup.secVoice': '语音',
  'setup.default': '(默认)',
  'setup.on': '开',
  'setup.off': '关',
  'setup.yes': '是',
  'setup.no': '否',
  'setup.actStart': '保存并启动',
  'setup.actSave': '保存',
  'setup.actExit': '退出(丢弃改动)',
  'setup.exited': '已取消 —— 未保存任何改动',
  'setup.hintNone': '仅同一 Wi-Fi / 局域网',
  'setup.hintCf': '即时随机的临时 https 地址',
  'setup.hintCfNamed': '你自己的域名,稳定 HTTPS(最省心)',
  'setup.hintSsh': '你自己的服务器 / 边缘(tunlite)',
  'setup.hintNatapp': '国内可用(需 natapp authtoken)',
  'setup.hintCpolar': '国内可用,自动安装(需 cpolar authtoken)',
  'setup.domainQ': '临时还是固定域名?',
  'setup.domainTemp': '免费临时域名',
  'setup.domainTempHint': '每次重启会变',
  'setup.domainFixed': '固定/保留域名',
  'setup.valPort': '端口需为 1–65535 的整数',
  'setup.valRequired': '{label} 不能为空',
  'setup.valHost': '请输入有效域名(如 myapp.example.com)',
  'setup.sumTemp': '临时',
  'setup.sumFixed': '固定',
  'setup.sumLan': '局域网',
  'setup.wrote': '✓ 已写入 {path}',
  'setup.pushKeep': '保留已配置的推送通知吗?',
  'setup.pushSetup': '现在配置推送通知吗?(会生成 VAPID 密钥)',
  'setup.pushContact': '联系方式(mailto: 或 https 地址,供推送服务使用)',
  'setup.pushGenerated': '✓ 已生成 VAPID 密钥对',
  'setup.voiceKeep': '保留已配置的语音输入吗?',
  'setup.voiceSetup': '现在配置语音输入吗?(需要讯飞/xfyun 密钥)',
  'setup.voiceAppId': 'xfyun appId',
  'setup.voiceApiKey': 'xfyun apiKey',
  'setup.voiceApiSecret': 'xfyun apiSecret',
  'setup.voiceSkipped': '  (已跳过 —— 字段缺失)',
  'setup.cfLogin': '→ 正在登录 Cloudflare(会打开一个浏览器)…',
  'setup.cfReuse': '✓ 复用已有隧道 {name}({id})',
  'setup.cfCredMissing1': '⚠ 本机找不到凭据文件 {file} —— 该隧道很可能是',
  'setup.cfCredMissing2': '  在别处创建的。运行 `{bin} tunnel delete {name}` 再重新 setup,即可在本机重建。',
  'setup.cfCreate': '→ 正在创建隧道 {name} …',
  'setup.cfRoute': '→ 正在把 {host} 路由到隧道 …',
  'setup.cfRouteFail': '⚠ route dns 失败 —— {domain} 的 DNS 托管在 Cloudflare 上吗?',
  'setup.cfRouteFail2': '  在 Cloudflare 上添加该域名(免费)并把 nameserver 指过去,然后重新 setup。',
  'setup.sshReady': '✓ 免密 SSH 已配置好',
  'setup.sshSetup': '→ 正在配置到 {host} 的免密 SSH(你需要输入一次密码)…',
  'setup.sshHelp1': '服务端(一次性):把反向代理指向被转发的 loopback 端口。',
  'setup.sshHelpNginx': '  nginx:  proxy_pass http://127.0.0.1:{port};  (加上 client_max_body_size 60m; proxy_read_timeout 90s;)',
  'setup.sshHelpCaddy': '  caddy:  {url} {  reverse_proxy 127.0.0.1:{port}  }',
  'setup.previewHelp1': '可选 —— 动态端口预览(在手机上按端口打开一个 dev server):',
  'setup.previewHelp2': '  在配置里设  "previewDomain": "..."  ,并把通配预览域名路由到网关。',
  'setup.previewTlsCf': '  TLS:Cloudflare 的免费证书只覆盖一级(*.example.com);更深一层(*.preview.example.com)需要 Advanced Certificate Manager。',
  'setup.previewTlsEdge': '  TLS:由你自己的边缘提供通配证书(例如 Let\'s Encrypt 的 *.preview.your.domain)。',

  // help
  'help.body': `handmux —— 从手机驱动你的 tmux

  handmux start            直接运行(默认仅局域网;无需配置)
  handmux open <会话名>     接入 tmux 会话,不存在则新建——手机上建的也能一键接管
  handmux setup            配置隧道 / 名称 / 通知(写入配置;重跑即可修改)
  handmux stop | restart | status
  handmux logs [--follow] [--lines N]
  handmux update           升级到最新发布版本(npm i -g handmux@latest)

模型:'start' 运行 · 'setup' 配置(写入 ~/.handmux/config.json)· 重跑 setup 即可修改。
flag 仅本次覆盖某一项、绝不持久化(优先级 flag > file > default)。

进阶(脚本 / 多套配置):
  handmux config                        显示生效的配置 + 每一项来自哪里
  handmux hooks install|uninstall         启用/停用 Claude Code 通知(收件箱)
  handmux service install [start-flags]   开机自启(launchd/systemd)
  handmux service uninstall               移除自启项
  --config PATH             使用指定配置文件,替代 ~/.handmux/config.json(开发 / 多套配置)
  --lang en|zh              CLI 语言(默认:根据你的 shell locale 自动检测)
  --version, -v            打印 handmux 版本

start flag(仅本次覆盖 —— 要持久化请用 'handmux setup'):
  --tunnel none|cloudflare|cloudflare-named|ssh|natapp|cpolar   暴露方式(默认:none)
  --ssh-host user@host[:port]   ssh 隧道目标(tunlite)
  --remote-port N               绑定在 ssh 主机上的端口(默认:--port)
  --public-url URL              对外公布的公网地址(任意隧道均可,包括自建的 none;
                                ssh 默认 http://host:remotePort;natapp/cpolar 填你的固定/保留域名 ——
                                留空则用免费临时域名)
  --ssh-jump u@h[,…]            ssh 的可选跳板机
  --cf-hostname H               cloudflare-named 的公网域名
  --cf-tunnel-name N            cloudflare-named 的隧道名(默认:handmux)
  --authtoken T                 natapp / cpolar 的 authtoken(或 HANDMUX_AUTHTOKEN)
  --cpolar-region R             cpolar 边缘区域,如 cn(或 HANDMUX_CPOLAR_REGION)
  --port N                  服务端口(默认:19999)
  --host H                  绑定地址(默认:0.0.0.0)
  --token S                 鉴权令牌(默认:自动生成)
  --name "My Box"           浏览器标签 + 主屏图标里的应用名
  --preview-domain D        启用动态预览(需要通配子域名)
  --foreground, -f          前台运行(不后台化)
  --no-qr                   不渲染二维码
`,
};
