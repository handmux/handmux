// 中文字典。键与 en.js 一一对应;缺键会自动回退到英文。命令名、flag、隧道名等字面量保持英文(它们是要照抄输入的)。
export default {
  // 通用
  'err.generic': '✗ {msg}',
  'err.configNotFound': '✗ --config {path}:找不到该文件',
  'err.badConfig': '✗ 配置有误 {path}:{msg}',
  'err.namedNotProvisioned': '✗ 命名隧道尚未配置 —— 请先运行 `handmux setup`',
  'lifecycle.busy': '✗ 另一个 handmux 启停操作正在进行(pid {pid})，请稍后重试。',
  'lifecycle.scanFailed': '✗ 无法检查 handmux supervisor 进程；为避免启动重复实例，本次操作已停止。',

  // start / service install 顶部打印的配置来源
  'config.loaded': '配置:{path}',
  'config.none': '(无 —— 使用 flag + 默认值)',

  // 快捷项编辑器
  'shortcuts.title': '必备常用快捷项',
  'shortcuts.command': '命令模式',
  'shortcuts.chat': '聊天模式',
  'shortcuts.count': '{n} 项',
  'shortcuts.save': '保存并退出',
  'shortcuts.exit': '放弃修改',
  'shortcuts.addKey': '添加按键',
  'shortcuts.addText': '添加文字',
  'shortcuts.back': '返回',
  'shortcuts.edit': '编辑',
  'shortcuts.move': '移动位置',
  'shortcuts.movePrompt': '移动到',
  'shortcuts.moveFirst': '1 · 最前',
  'shortcuts.moveAfter': '{n} · {item} 之后',
  'shortcuts.moveLast': '{n} · 最后',
  'shortcuts.delete': '删除',
  'shortcuts.type': '快捷项类型',
  'shortcuts.key': '按键',
  'shortcuts.text': '文字',
  'shortcuts.textEnter': '文字 · 发送后回车',
  'shortcuts.textOnly': '文字 · 只输入',
  'shortcuts.textPrompt': '输入文字内容',
  'shortcuts.badText': '请输入一行非空文字',
  'shortcuts.enter': '文字后敲 Enter？',
  'shortcuts.modifier': '修饰键',
  'shortcuts.noModifier': '无',
  'shortcuts.base': '基础键',
  'shortcuts.needTty': 'handmux shortcuts 需要交互式终端。',
  'shortcuts.wrote': '已保存 {path}',
  'shortcuts.exited': '未保存修改',
  'shortcuts.applied': '已立即应用到正在运行的 handmux。',
  'shortcuts.applyFailed': '配置已保存，但无法立即应用：{msg}。请运行 `handmux restart`。',

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
  'start.instancesFound': '✗ 检测到未登记或重复的 handmux supervisor(pid: {pids})。',
  'start.instancesHint': '  为避免再启动一份，本次不会继续。请先运行 `handmux stop` 回收全部副本。',

  // start —— 启动中
  'start.overrides': '  ↳ --tunnel {flag} 仅本次覆盖配置文件里的 {file}',
  'start.foreground': '正在启动 handmux(隧道:{tunnel},端口:{port})—— 按 Ctrl-C 停止',
  'start.starting': '正在启动 handmux(隧道:{tunnel},端口:{port})…',

  // stop / status
  'stop.notRunning': 'handmux 未在运行',
  'stop.stopped': '已停止 handmux(pid {pid})',
  'stop.stoppedMany': '已停止重复的 handmux 实例(pid: {pids})',
  'stop.stoppedManaged': '已停止 handmux 托管服务',
  'stop.timeout': '✗ handmux(pid: {pids})未能完全停止；为避免启动双实例，本次不会继续启动。请运行 `handmux status` / `handmux logs` 检查。',
  'status.stopped': '● handmux {version} 已停止',
  'status.running': '● handmux {version} 运行中',
  'status.installed': '  已安装版本 {version}(重启后生效)',
  'status.untracked': '⚠ 状态文件已失效，但仍检测到 handmux supervisor(pid: {pids})；运行版本未知，已安装版本为 {version}。',
  'status.duplicates': '⚠ 检测到多个 handmux supervisor(pid: {pids})；下方访问信息仅来自最后写入状态的实例。',
  'status.cleanupHint': '  运行 `handmux stop` 可回收全部副本。',
  'status.scanFailed': '⚠ 无法检查 supervisor 进程表；以下状态仅来自 state.json。',

  // logs
  'logs.none': '(还没有日志 —— 先运行 handmux start)',

  // update
  'update.available': '  ⬆  handmux {latest} 可升级(当前 {current})',
  'update.how': '     升级:  handmux update  (或 npm i -g handmux@latest)',
  'update.howBrew': '     升级:  brew upgrade handmux',
  'update.brew': '这个 handmux 是用 Homebrew 安装的 — 请用:  brew upgrade handmux 升级',
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
  'setup.laterRestart': "已在运行 —— 运行 'handmux restart' 让改动生效。",
  'setup.needTty': 'handmux setup 需要一个交互式终端',
  'setup.langQ': '命令行语言(handmux 终端输出)/ Command-line language',
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
  'setup.askPublicUrl': '公网地址,http(s):// 按情况填(留空 = http://host:remotePort)',
  'setup.natappGuide': '去哪拿 authtoken:到 https://natapp.cn 免费注册 → 新建一条隧道 → 复制它的 authtoken(免费额度够上手)。',
  'setup.cpolarGuide': '去哪拿 authtoken:到 https://cpolar.com 免费注册 → 打开后台 → 验证/Verify → 复制你的 authtoken。',
  'setup.askAuthtoken': 'authtoken',
  'setup.askFixed': '用固定域名吗?(否 = 免费临时域名,每次重启都会变)',
  'setup.askNatappDomain': '你在 natapp 后台为该 authtoken 绑定的固定域名(例如 myapp.natapp1.cc)',
  'setup.askCpolarDomain': '你保留的二级域名或绑定的自有域名(例如 myapp.cpolar.top)',
  'setup.askCpolarRegion': 'cpolar 区域(cn = 中国大陆,国内更快;留空 = cpolar 默认)',
  'setup.natappReady': '✓ natapp 客户端就绪',
  'setup.cpolarReady': '✓ cpolar 客户端就绪',
  // setup 中枢(菜单模型)
  'setup.welcome': 'handmux 开源、自身不设中转——手机连的始终是你自己的电脑,更私密安全;同一 Wi-Fi 下就是纯直连、开箱即用(选「直连」即可)。想在外网也能连,下面几个是内置帮你打通的方式,用你自己的免费账号即可。不确定就在高亮项上按 Enter,之后随时能改。',
  'setup.hubTitle': '要改什么吗?(或直接保存并启动)',
  'setup.secConnection': '连接',
  'setup.secName': '名称',
  'setup.secPort': '端口',
  'setup.secToken': '令牌',
  'setup.tokenAuto': '自动 · 每次启动新生成',
  'setup.tokenCustom': '自定义令牌…',
  'setup.tokenRandom': '随机生成一个',
  'setup.tokenReset': '恢复自动(每次启动新生成)',
  'setup.askToken': '访问令牌 —— 会出现在手机打开的网址里',
  'setup.tokenGenerated': '新令牌:{token}',
  'setup.valToken': '请输入令牌',
  'setup.valTokenSpace': '不能有空格 —— 令牌会放进网址',
  'setup.secLanguage': '命令行语言 / CLI language',
  'setup.secPush': '推送',
  'setup.secVoice': '语音',
  'setup.default': '(默认)',
  'setup.on': '开',
  'setup.off': '关',
  'setup.yes': '是',
  'setup.no': '否',
  'setup.escBack': '(Esc 返回)',
  'setup.actStart': '保存并启动',
  'setup.actRestart': '保存并重启(立即生效)',
  'setup.actSave': '保存',
  'setup.actExit': '退出(丢弃改动)',
  'setup.exited': '已取消 —— 未保存任何改动',
  'setup.tunnelNone': '直连',
  'setup.hintNone': '不经隧道,直连本机 —— 同一 Wi-Fi 或本机有公网 IP 均可;最简单',
  'setup.hintCf': '在外面也能访问、免注册(临时地址;国内可能不稳)',
  'setup.hintCfNamed': '你自己的域名,稳定 HTTPS(最省心)',
  'setup.hintSsh': '你已经有一台服务器可以中转',
  'setup.hintNatapp': '在外面也能访问、国内稳(需免费 natapp 账号)',
  'setup.hintCpolar': '在外面也能访问、国内稳、自动安装(需免费 cpolar 账号)',
  'setup.domainQ': '临时还是固定域名?',
  'setup.domainTemp': '免费临时域名',
  'setup.domainTempHint': '每次重启会变',
  'setup.domainFixed': '固定/保留域名',
  'setup.valPort': '端口需为 1–65535 的整数',
  'setup.valRequired': '{label} 不能为空',
  'setup.valHost': '请输入有效域名(如 myapp.example.com)',
  'setup.valContact': '请填 mailto:you@example.com 或 https://你的站点(要真实域名 —— 苹果会拒收假域名)',
  'setup.sumTemp': '临时',
  'setup.sumFixed': '固定',
  'setup.sumNoRelay': '无中转',
  // 连接迷你中枢(各隧道字段行)
  'setup.connTunnel': '隧道',
  'setup.connMode': '模式',
  'setup.connHostname': '域名',
  'setup.connTunnelName': '隧道名',
  'setup.connSshHost': 'SSH 主机',
  'setup.connRemotePort': '远程端口',
  'setup.connPublicUrl': '公网地址',
  'setup.connJump': '跳板机',
  'setup.connDomain': '域名',
  'setup.connRegion': '区域',
  'setup.connNone': '(未设置)',
  'setup.connAuto': '(自动)',
  'setup.askSshJump': 'ssh 跳板机(user@host,留空=无)',
  'setup.cfModeQ': 'cloudflare 地址',
  'setup.cfTemp': '临时地址(免登录)',
  'setup.cfTempHint': '即时随机 https,重启会变',
  'setup.cfNamed': '命名隧道(你的域名)',
  'setup.cfNamedHint': '稳定 HTTPS,需登录 Cloudflare',
  'setup.wrote': '✓ 已写入 {path}',
  'setup.pushKeep': '保留已配置的推送通知吗?',
  'setup.pushSetup': '开启手机通知吗?(编程 agent 干完活时提醒你)',
  'setup.pushAbout': 'handmux 会为你自动生成一把私有签名密钥,存在 ~/.handmux/config.json,始终不出本机。下面的联系方式只是给推送服务留的联系地址,别人看不到。',
  'setup.pushContact': '给推送服务留的联系方式 —— mailto: 或 https://(用默认即可;保留 mailto: 前缀)',
  'setup.pushGenerated': '✓ 已生成签名密钥对(存在本机配置里)',
  'setup.pushContactLabel': '联系人',
  'setup.pushRegen': '重新生成密钥',
  'setup.pushRegenHint': '会重置所有手机的订阅',
  'setup.pushRegenConfirm': '重新生成密钥?已订阅的每台手机都会收不到通知,直到重新打开网页 App 再订阅一次。只有密钥泄露时才需要这么做。',
  'setup.pushRegenerated': '✓ 已重新生成密钥 —— 手机需重新订阅',
  'setup.pushOff': '关闭推送',
  'setup.voiceOff': '关闭语音',
  'setup.voiceKeep': '保留已配置的语音输入吗?',
  'setup.voiceSetup': '开启语音输入吗?(对着手机说话转文字;需讯飞账号)',
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

  // 工作区恢复
  'restore.usage': '用法: handmux restore [--dry-run] [--checkpoint <id>] [--session <name>] | handmux restore --list',
  'restore.badFlag': '未知的恢复参数 {flag}。',
  'restore.unexpectedArgument': '未预期的恢复参数: {value}。',
  'restore.unknownShortFlag': '未知的恢复参数 {flag}。',
  'restore.flagBoolean': '{flag} 不接受参数值。',
  'restore.checkpointValue': '--checkpoint 需要一个 id（或 latest）。',
  'restore.checkpointId': '--checkpoint 必须是有效 id，只能包含字母、数字、点、下划线或连字符。',
  'restore.sessionValue': '--session 需要一个非空会话名。',
  'restore.listExclusive': '--list 必须独占使用，不能与 --dry-run、--checkpoint 或 --session 组合。',
  'restore.listRow': '{id}  {time}  {sessions} 个会话 · {windows} 个窗口 · {panes} 个窗格 · {agents} 个 agent',
  'restore.listUnavailable': '{id}  不可用: {error}',
  'restore.listEmpty': '目前还没有已归档的工作区备份。',
  'restore.selectCheckpoint': '选择要恢复的工作区备份',
  'restore.selectHint': '{time} · {sessions} 个会话 · {windows} 个窗口 · {panes} 个窗格',
  'restore.noCheckpoint': '没有可用的历史备份。handmux 正在静默保护当前工作区；请在电脑或 tmux 下次重启后再试。',
  'restore.selectionCancelled': '没有选择备份。准备好后可再次运行 `{command}`。',
  'restore.planCheckpoint': '备份: {time}（{id}；{sessions} 个会话，{windows} 个窗口，{panes} 个窗格）',
  'restore.planCurrent': '当前: {sessions} 个在线会话',
  'restore.planCreate': '+ {session}',
  'restore.planRenamed': '+ {session} -> {target}（名称已被占用）',
  'restore.planAlready': '= {session}（已经恢复）',
  'restore.planUnavailable': '! {session}（不可用: {reason}）',
  'restore.reason.linkedWindows': '该备份含有当前版本无法安全恢复的链接窗口',
  'restore.reason.invalidTopology': '该备份的 tmux 拓扑不完整或无效',
  'restore.reason.unknown': '不支持的备份拓扑（{reason}）',
  'restore.manualRecovery': '请改为手动恢复这个会话: {command}',
  'restore.warning': '警告: {warning}',
  'restore.sessionWarning': '  {session} 警告: {warning}',
  'restore.nonDestructive': '不会停止或修改任何现有会话或进程。',
  'restore.nonDestructivePast': '现有会话没有被修改。',
  'restore.dryRunHint': '运行 `{command}` 继续。',
  'restore.resultRestored': '✓ {session}',
  'restore.resultRenamed': '✓ {session} 已恢复为 {target}',
  'restore.resultAlready': '= {session}（已经恢复）',
  'restore.sessionFailed': '备份 {checkpoint}；会话 {session}；阶段 {stage}: {error}',
  'restore.operationFailed': '备份 {checkpoint}；阶段 {stage}: {error}',
  'restore.retrySession': '只重试这个会话: {command}',
  'restore.resultSummary': '已恢复 {restored} 个会话；{already} 个已存在；{failed} 个失败。',
  'restore.error': '备份 {checkpoint} 在恢复命令阶段失败: {error}',
  'restore.retry': '修复上面报告的原因后，运行 `{command}` 重试。',

  // help
  'help.body': `handmux —— 从手机驱动你的 tmux

  handmux start            直接运行(默认仅局域网;无需配置)
  handmux open <会话名>     接入 tmux 会话,不存在则新建——手机上建的也能一键接管
  handmux setup            配置隧道 / 名称 / 通知(写入配置;重跑即可修改)
  handmux shortcuts        配置命令/聊天模式的必备常用快捷项
  handmux stop | restart | status
  handmux logs [--follow] [--lines N]
  handmux push <标题> <正文>    从脚本推一条通知到手机（--session 会话 · --device 设备key · --tag · --url）
  handmux restore [--dry-run] [--checkpoint <id>] [--session <name>]
  handmux restore --list
  handmux update           升级到最新发布版本(npm i -g handmux@latest)

第一次用?跑 'handmux setup' —— 它会带你配好外网访问 + 手机通知。
模型:'start' 运行 · 'setup' 配置(写入 ~/.handmux/config.json)· 重跑 setup 即可修改。

更多:
  handmux config                          显示生效的配置 + 每一项来自哪里
  handmux hooks install|uninstall         启用/停用 agent 通知(收件箱)
  handmux service install|uninstall       开机自启(launchd/systemd)
  handmux help flags                      一次性 flag + 环境变量(脚本 / 无头 / Docker)
  --config PATH · --lang en|zh · --version, -v
`,
  'help.flags': `handmux flag —— 一次性覆盖 & 无头配置

优先级:flag > 文件(~/.handmux/config.json)> 环境变量(HANDMUX_*)> 默认值。
flag 仅本次覆盖某一项、绝不持久化 —— 要持久化请用 'handmux setup'。
环境变量是无头场景(Docker / systemd / CI)的配置面,会跨多次运行生效。

start flag(括号内为对应环境变量):
  --tunnel none|cloudflare|cloudflare-named|ssh|natapp|cpolar   暴露方式(默认:none)
  --port N                      服务端口(HANDMUX_PORT,默认:19999)
  --host H                      绑定地址(HANDMUX_HOST,默认:0.0.0.0)
  --token S                     鉴权令牌(HANDMUX_TOKEN,默认:每次启动自动生成)
  --name "My Box"               浏览器标签 + 主屏图标里的应用名(HANDMUX_APP_NAME)
  --public-url URL              对外公布的公网地址(HANDMUX_PUBLIC_URL;任意隧道均可,包括自建的 none;
                                ssh 默认 http://host:remotePort;natapp/cpolar 填你的固定/保留域名 ——
                                留空则用临时域名)
  --ssh-host user@host[:port]   ssh 隧道目标(HANDMUX_SSH_HOST)
  --remote-port N               绑定在 ssh 主机上的端口(HANDMUX_REMOTE_PORT,默认:--port)
  --ssh-jump u@h[,…]            ssh 的可选跳板机(HANDMUX_SSH_JUMP)
  --cf-hostname H               cloudflare-named 的公网域名(HANDMUX_CF_HOSTNAME)
  --cf-tunnel-name N            cloudflare-named 的隧道名(HANDMUX_CF_TUNNEL_NAME,默认:handmux)
  --authtoken T                 natapp / cpolar 的 authtoken(HANDMUX_AUTHTOKEN)
  --cpolar-region R             cpolar 边缘区域,如 cn(HANDMUX_CPOLAR_REGION)
  --preview-domain D            启用动态预览,需要通配子域名(HANDMUX_PREVIEW_DOMAIN)
  --foreground, -f              前台运行(不后台化)
  --no-qr                       不渲染二维码

很少用到(环境变量或 flag):--static-dir / --upload-exts / --preview-ttl
  (HANDMUX_STATIC_DIR / HANDMUX_UPLOAD_EXTS / HANDMUX_PREVIEW_TTL)

'handmux service install' 也接受上面这些 start flag —— 它们会被烘进自启项。
`,
};
