// User-facing changelog — newest first, keyed by RELEASE VERSION (not date). Hand-curated (concise
// "what changed" lines, user-felt highlights, not git noise); add an entry when shipping a release.
// Shape per entry:
//   version:   the public semver ('0.9.1'); OMITTED for the pre-1.0 internal builds, which are merged
//              into a single dateless "early builds" entry at the bottom.
//   date:      shown after the version ("v0.9.1 · 2026-07-06"); informative, not the sort key.
//   highlight: { zh, en } — ONE very short line. This is what the phone shows as "what's new" when an
//              update is available (surfaced pre-upgrade via server/package.json `whatsNew`, so keep it
//              terse). release.sh mirrors the top few versions' highlights into package.json.
//   items:     { zh, en } — parallel arrays (same order/count per locale), the full per-release list.
// `entryId`/`LATEST_RELEASE` use `version` when present, else `date`, as the stable unread-dot id.
export const CHANGELOG = [
  {
    version: '0.17.0',
    date: '2026-07-18',
    highlight: {
      zh: '对话镜头(实验性)· 通知记录 · 本机地址一键预览',
      en: 'Chat lens (experimental) · notification inbox · one-tap localhost preview',
    },
    items: {
      zh: [
        '新增「对话镜头」(实验性功能,默认关):到设置里打开「启用对话镜头(实验性功能)」后,窗口栏就能把 Claude 会话在终端/对话两个镜头间一键切换(需已装 Claude hooks,没装可一键安装)。对话镜头把会话读成聊天记录——气泡 + Markdown、工具卡(编辑文件带 +A/−B 和彩色 diff)、Claude 提问时点按即答的问题卡、上下文压缩动画、三套暖色配色;终端镜头照旧,完全不受影响。',
        '新增「通知记录」:脚本推送(handmux push)的通知按设备留存(各 100 条),全屏翻看、点开看详情、逐条删除;点手机上的通知直接跳到那条消息的详情。',
        '终端里打印的本机地址(localhost:3000 等)自动变成可点的:点一下就能起代理在手机上预览(带路径),多个端口还能并行切换、自动续期。',
        '修复了对话镜头 /clear 后残留旧会话内容、问题卡确认后偶发闪现多余卡片、长输出在工具卡里滑不到、消息不足一屏时无法加载更早消息的问题。',
      ],
      en: [
        'New chat lens (experimental, off by default): enable it in Settings → Enable chat lens, then flip a Claude pane between terminal and chat from the window bar (requires Claude hooks — one-tap install offered). The chat lens reads the session as a conversation — bubbles with Markdown, tool cards (+A/−B and colored diffs for file edits), question cards you answer with a tap, a visible compaction animation, and three warm colour tones. The terminal lens is untouched.',
        'New notification inbox: pushes from handmux push are kept per device (latest 100) — browse full-screen, open details, delete one by one; tapping a push lands on that message’s detail.',
        'Localhost URLs printed in the terminal (localhost:3000, …) are now tappable: one tap proxies and previews them on your phone (path preserved), with several ports open in parallel and auto-renewed.',
        'Fixed chat-lens issues: stale content after /clear, a stray fallback card flashing after answering a question, long tool output unreachable in the sheet, and older messages unloadable when the window was shorter than a screen.',
      ],
    },
  },
  {
    version: '0.16.0',
    date: '2026-07-15',
    highlight: {
      zh: '分屏布局地图 · 手机也能建/删窗格',
      en: 'Split-layout map · create & close panes from the phone',
    },
    items: {
      zh: [
        '有多个窗格的窗口,选择器不再是一条干巴巴的下拉列表,而是照着你屏幕上真实的分屏样子画出来:每一格对应一个窗格,标着序号、正在跑的命令和 Agent 图标,一眼就看出谁在左谁在右、谁在上谁在下,点一下就切过去看那一格。',
        '现在手机上就能直接分屏和关窗格了:长按地图里的某一格,就能把它「左右分屏」或「上下分屏」,也能「关闭」;还没分屏的窗口在它的菜单里也能分,已经分屏的窗口菜单里点「管理分屏」直接进地图。分好之后自动就落在新的那格里,地图也一直开着,随时能接着分或关。',
        '绑定会话的弹窗更清楚了:「新建会话」和「选已有会话」分成两个明确的选项,不会再让人以为点一下「新建」就直接把会话建出来。',
      ],
      en: [
        'For a window with several panes, the picker is no longer a plain dropdown — it’s drawn to match the way your screen is actually split: each tile is one pane, labelled with its number, the command it’s running, and its agent, so you can tell at a glance which pane is where. Tap a tile to jump to that pane.',
        'You can now split and close panes right from the phone: long-press a tile in the map to Split it left/right or top/bottom, or Close it; a window that isn’t split yet can be split from its menu, and a split window has a “Manage split” entry that opens the map. After a split you’re dropped into the new pane, and the map stays open so you can keep splitting or closing.',
        'The bind-session dialog is clearer: “New session” and “Pick an existing session” are now two distinct choices, so tapping “New” no longer looks like it creates a session on the spot.',
      ],
    },
  },
  {
    version: '0.15.0',
    date: '2026-07-14',
    highlight: {
      zh: '键盘弹起终端自适应 · 全屏程序可上下滚动',
      en: 'Keyboard-aware terminal · scroll inside full-screen apps',
    },
    items: {
      zh: [
        '键盘弹起时终端不再被顶飞:内容自动重排到键盘上方,主屏短内容贴着键盘上沿显示;全屏程序(vim/less/htop 等)可以在里面上下滚动、到顶/底才翻页,默认显示程序的第一行,移动光标时自动跟随。',
        '全屏程序翻页键上方新增「适配高度」和「定位」两个按钮:「适配高度」一键缩字号,收起键盘就能把整屏程序完整塞进手机屏;「定位」点亮后高亮光标所在行并跟随,方便在长内容里盯住光标。键盘弹起的瞬间光标也一直可见,不用再补按一下。',
        '收件箱在一种特定场景下抓不到状态变更:你回应了权限弹窗、但那次回应没产生任何收尾信号时(普通授权、拒绝并反馈、或按 ESC 中断),它会停留在「需要你」。这一版补上识别——授权或拒绝反馈后回到「进行中」,ESC 中断则消掉状态。',
        '光标不用点屏幕也能看到了:一进会话就能看到光标位置,发键/发指令后即使 Claude 正在忙也会亮着。',
        '从设置里启动动态端口预览,现在会像静态预览一样自动弹出预览面板。',
        '会话重命名撞到已有名字时,会明确提示「名称已存在」;修复了终端上滑一点后画面自己往上爬的问题。',
      ],
      en: [
        'The terminal no longer gets shoved off-screen when the keyboard opens: content reflows to sit just above the keyboard, with short main-screen output resting on its top edge. Full-screen programs (vim/less/htop, etc.) now scroll up/down inside themselves and only page at the edges, default to showing the program’s first line, and follow the cursor as you move it.',
        'Two new buttons above the full-screen pager: “Fit height” shrinks the font in one tap so the whole program fits on the phone with the keyboard down, and “Locate” highlights and follows the cursor’s row so you can keep track of it in long content. The cursor also stays visible the moment the keyboard opens — no extra tap needed.',
        'In one specific case the inbox couldn’t pick up a state change: when you responded to a permission prompt but that response produced no closing signal (a normal approval, a deny-with-feedback, or an ESC interrupt), it would linger on “needs you”. This release adds that detection — approving or denying returns it to “working”, and an ESC interrupt clears it.',
        'The cursor now shows without tapping the screen: you can see where it is the moment you open a session, and it stays lit after you send a key/command even while Claude is busy.',
        'Starting a dynamic-port preview from Settings now auto-opens the preview sheet, just like a static one.',
        'Renaming a session to a name that already exists now says so clearly; and fixed the terminal creeping upward a line at a time after a small scroll up.',
      ],
    },
  },
  {
    version: '0.14.0',
    date: '2026-07-13',
    highlight: {
      zh: '终端文字选中拷贝 · 脚本复用推送通道',
      en: 'Terminal select & copy · scripts reuse the push channel',
    },
    items: {
      zh: [
        '终端可以长按选中文字了:iOS 式首尾手柄精调、跨屏选择,浮条一键拷贝/整行/整段,复制自动去掉行尾空格;选中期间顶部显示「复制模式 · N 行 · M 字」。',
        '你自己的脚本也能复用 handmux 的推送通道:命令行用 handmux push <标题> <正文> 直接给手机发通知(可选 --session/--device 限定范围),脚本跑完主动提醒你。',
        '滚动终端不再收起键盘:滑动时键盘保持、单击才收起;还能用 ⌨ 按钮或底部手柄拖拽显隐键盘,命令/聊天切换也保持键盘不掉。',
        '往上滑看历史更顺了:一次滑到顶只加载一页、不再叠加拉取来回跳,位置稳停在你看的那行,顶部显示「距底 N/M 行」。',
        '全屏程序(vim/less/htop 等)上方不再串出无关的终端历史。',
        '修复了主页误触返回直接退出、以及从通知进入要多按一次返回才能退出的问题。',
      ],
      en: [
        'You can now long-press to select text in the terminal: iOS-style start/end handles, selection across screens, a callout to copy / whole line / whole paragraph, with trailing spaces trimmed on copy. A “copy mode · N lines · M chars” bar shows while selecting.',
        'Your own scripts can reuse handmux’s push channel: run handmux push <title> <body> to send a notification straight to your phone (optionally scoped with --session/--device) — handy for a script pinging you when it finishes.',
        'Scrolling the terminal no longer dismisses the keyboard: a swipe keeps it up, a single tap puts it away; you can also show/hide it with the ⌨ button or the dock’s grip handle, and it stays up when you switch between command and chat.',
        'Scrolling up through history is smoother: reaching the top loads exactly one page instead of stacking pulls and jumping around, and your place holds steady on the line you were reading, with a “N/M lines from bottom” readout.',
        'A full-screen program (vim/less/htop, etc.) no longer leaks unrelated terminal history above it.',
        'Fixed a stray Back on the home page dropping you straight out, and needing an extra Back to leave after opening the app from a notification.',
      ],
    },
  },
  {
    version: '0.13.0',
    date: '2026-07-12',
    highlight: {
      zh: '终端文件路径高亮可点',
      en: 'Tappable, highlighted file paths',
    },
    items: {
      zh: [
        '终端里的文件路径现在会高亮显示、可以直接点开;这个高亮可以在设置里开关(默认关闭)。',
        '桌面浏览器用鼠标滚轮往上翻,现在能拉出更深的历史了(不再卡在第一屏);桌面和手机都加了一条纤细的滚动条。',
        '设置面板太高时可以整体滚动了,标题和关闭按钮始终可见、够得到。',
        '修复了 agent 图标和底部输入模式偶尔乱跳的问题——现在按 agent 是否真的在运行来判断,分屏里每个窗格也各显各的图标。',
        'handmux setup 新增「令牌」一项:可以手动固定访问令牌,这样每次重启后手机网址不再变化(留空则仍每次自动生成一个)。',
      ],
      en: [
        'File paths in the terminal are now highlighted and tappable — tap one to open it. You can toggle the highlight in Settings (off by default).',
        'On a desktop browser the mouse wheel now pulls deeper history instead of stalling at the first screen, and a thin scrollbar was added on both desktop and mobile.',
        'The Settings sheet scrolls as a whole when it is taller than the screen, with the title and close button always reachable.',
        'Fixed the agent icon and the bottom input mode occasionally jumping around — both now track whether the agent is actually running, and each pane in a split shows its own icon.',
        'handmux setup has a new “Token” item: you can pin the access token by hand so the phone URL stops changing on every restart (leave it blank to keep auto-generating one each start).',
      ],
    },
  },
  {
    version: '0.12.3',
    date: '2026-07-11',
    highlight: {
      zh: '接管会话可自定义名称 + Homebrew 一键安装',
      en: 'Name a takeover session · Homebrew install',
    },
    items: {
      zh: [
        '接管电脑上的会话时,可以自己给新会话起名(默认也帮你填好);接管后想回电脑继续的命令,现在直接显示成 handmux open <名称>,照着敲即可。',
        '新增 Homebrew 一键安装:没装 Node 的 Mac 也能用 brew install handmux/tap/handmux 一条命令装好(handmux + Node + tmux)。已有 Node 的话,npm i -g handmux 仍是更轻的选择。',
      ],
      en: [
        'When taking over a session running on your computer, you can now name the new session yourself (a default is filled in), and the “continue on the computer” hint shows the exact command to run — handmux open <name>.',
        'New Homebrew install: on a Mac without Node, brew install handmux/tap/handmux sets up handmux, Node, and tmux in one command. If you already have Node, npm i -g handmux stays the lighter option.',
      ],
    },
  },
  {
    version: '0.12.2',
    date: '2026-07-11',
    highlight: {
      zh: '修复主屏图标偏大 / 换图标后不刷新',
      en: 'Home-screen icon: right size & always fresh',
    },
    items: {
      zh: [
        '修复了「添加到主屏」的图标在安卓上偏大、以及更换图标后旧图标不刷新的问题——图标更新现在会自动生效(已加到 iPhone 主屏的需删掉重加一次)。',
      ],
      en: [
        'Fixed the Add-to-Home-Screen icon looking oversized on Android and a changed icon not refreshing for returning users — icon updates now apply automatically (one already on an iOS home screen needs a one-time remove + re-add).',
      ],
    },
  },
  {
    version: '0.12.1',
    date: '2026-07-11',
    highlight: {
      zh: '全新品牌图标与双色字标',
      en: 'New brand icon & two-tone wordmark',
    },
    items: {
      zh: [
        '焕新品牌:全新的发光终端图标(主屏图标、启动页都换了)+ 圆润的双色「handmux」字标(hand 白、mux 青→绿),官网、分享卡和 README 也一并更新。',
      ],
      en: [
        'Brand refresh: a new glowing terminal app icon (home-screen icon + boot splash) and a rounded two-tone "handmux" wordmark (hand in white, mux teal→green), with the site, share cards, and README updated to match.',
      ],
    },
  },
  {
    version: '0.12.0',
    date: '2026-07-11',
    highlight: {
      zh: '全屏程序也能滑动滚动 · 反馈入口 · 聊天草稿不丢',
      en: 'Swipe-scroll full-screen apps · feedback channels · chat drafts kept',
    },
    items: {
      zh: [
        '全屏程序(vim / htop / less 等)现在能直接滑动滚动了:开了鼠标的程序像电脑滚轮一样滑着滚,没开鼠标的分页器(less / man / git log)靠滑动逐行滚;每个全屏画面右侧还多了一枚翻页按钮做整页跳。',
        '设置里新增「反馈与交流」:直达 GitHub Issues,中文用户还能扫码进微信交流群;README、官网、文档里也都能找到入口。',
        '聊天框里没发出去的内容现在会自动保存,下次打开自动填回——误划走、切后台被杀、崩溃都不会再丢半截提示词。',
        '修复:从终端链接或「最近」直接打开的文档,点返回会一次收起面板,不再被硬塞进「目录」层、再返一次直接退出 App。',
      ],
      en: [
        'Full-screen apps (vim / htop / less …) now scroll by swipe: mouse-mode apps scroll like a desktop wheel, and pagers (less / man / git log) scroll line-by-line on a swipe; every full-screen view also gets a page up/down button on the right for whole-page jumps.',
        'New "Feedback" section in Settings: a direct link to GitHub Issues, plus a WeChat user group for Chinese users — also surfaced in the README, the site, and the docs.',
        'Whatever you\'ve typed in the chat box is now saved automatically and restored next time you open it — an accidental swipe-away, a background kill, or a crash no longer eats a half-written prompt.',
        'Fixed: a doc opened straight from a terminal link or 最近 now closes the sheet in one Back press, instead of being forced into its folder view and then dropping you out of the app on the next Back.',
      ],
    },
  },
  {
    version: '0.11.1',
    date: '2026-07-09',
    highlight: { zh: '修复 Node 18 下无法启动的问题', en: 'Fixes startup crash on Node 18' },
    items: {
      zh: [
        '修复了电脑用 Node 18 时 handmux 任何命令都启动不了的问题(0.11.0 配置向导引入的依赖要求过新的 Node)。',
      ],
      en: [
        'Fixed handmux failing to start any command on Node 18 (a dependency introduced by the 0.11.0 setup wizard required a newer Node).',
      ],
    },
  },
  {
    version: '0.11.0',
    date: '2026-07-08',
    highlight: { zh: '国内可用隧道 natapp/cpolar · 配置向导重做', en: 'China-usable tunnels · setup redesigned' },
    items: {
      zh: [
        '新增两条国内可用的隧道 natapp 和 cpolar:当 Cloudflare 在国内不稳定时,用你自己的免费账号就能把手机连到电脑。只要一个 authtoken;想要固定地址就填公网地址,留空则用免费临时域名;cpolar 的客户端还会自动下载。',
        '`handmux setup` 重做成菜单式向导:每项设置一行、直接显示当前值,想改哪项就点哪项,不用再一路问到底。连接分两级——先选隧道类型,再进去配它的参数;推送、语音也各成小面板。第一次用会一步步带你走,默认落在「直连」并停在「保存并启动」,小白也能顺下来。',
      ],
      en: [
        'Two China-usable tunnels, natapp and cpolar: when Cloudflare is unreliable inside mainland China, reach your computer from your phone using your own free account. Just an authtoken; add a public URL for a fixed address or leave it blank for a free temporary one — and cpolar\'s client auto-downloads.',
        '`handmux setup` is now a menu-style wizard: every setting is a row showing its current value, so you jump straight to what you want to change instead of answering every prompt in order. Connection is two levels — pick the tunnel type, then configure it inside; push and voice are their own mini-panels. A first run walks you through it, defaulting to "Direct" with the cursor on "Save & start".',
      ],
    },
  },
  {
    version: '0.10.0',
    date: '2026-07-06',
    highlight: { zh: '升级前预览新功能 · 电脑 handmux open 接管', en: 'Preview an update before installing · handmux open' },
    items: {
      zh: [
        '更新提示现在会提前告诉你新版有什么:检测到有新版本时,设置里会逐版列出这次升级带来的新功能(一句话说明),让你在电脑上跑 `handmux update` 之前就知道值不值得。',
        '电脑上新增 `handmux open <会话名>`:把你在手机上建的会话直接在电脑终端接回来(没有就新建),不用再记 `tmux new -A -s`。绑定/新建会话的弹窗里也加了这句提示。',
      ],
      en: [
        'The update notice now tells you what a new version brings before you install it: when an update is detected, Settings lists each newer version\'s highlight in one line, so you know whether it\'s worth running `handmux update` on your computer.',
        'New `handmux open <session>` on the computer: reclaim a session you created from your phone straight into your computer\'s terminal (created if missing) — no need to remember `tmux new -A -s`. The bind/create dialog now hints at it too.',
      ],
    },
  },
  {
    version: '0.9.1',
    date: '2026-07-06',
    highlight: { zh: '「添加到主屏」引导', en: '"Add to Home Screen" coach' },
    items: {
      zh: [
        '新增「添加到主屏」引导:第一次在浏览器里打开时,提示你把 handmux 装到主屏,像 App 一样全屏打开。安卓可一键安装;iPhone 给出 Safari 的「分享 → 更多 → 添加到主屏幕」三步——iOS 上收推送也需要它。装好后不再打扰。',
      ],
      en: [
        'New "Add to Home Screen" coach: the first time you open handmux in a browser, it shows how to install it to your home screen and run it full-screen like an app. Android installs in one tap; iPhone gets the Safari steps (Share → More → Add to Home Screen) — which is also what iOS push needs. It won\'t nag once you\'ve added it.',
      ],
    },
  },
  {
    version: '0.9.0',
    date: '2026-07-05',
    highlight: { zh: '聊天输入框多行重做', en: 'Multi-line chat composer redone' },
    items: {
      zh: [
        '聊天输入框多行重做:文字占满整行,麦克风/发送悬到右下角,末行快挤到按钮才让出一行——长消息不再被右侧按钮列挤窄,多行时拖光标也不会误收键盘。',
      ],
      en: [
        'Chat composer redone for multi-line: text takes the full width, mic/send float in the bottom-right corner, and a row is yielded only when the last line actually reaches them — long messages are no longer squeezed by a right-hand button column, and dragging the caret no longer collapses the keyboard.',
      ],
    },
  },
  {
    version: '0.8.0',
    date: '2026-07-05',
    highlight: { zh: '快捷栏可自定义 · 上传体验重做', en: 'Customizable quick-bars · upload redone' },
    items: {
      zh: [
        '命令模式的常用命令分成「全局」和「当前窗口」两组:快捷栏里全局的(灰)排前、当前窗口的(绿)排后。尾部改成 ⚙ 齿轮,点开更高的编辑器分两区、各自 ▲▼ 排序。新增区一行搞定:顶部「命令/按键」大 Tab 选类型,左侧开关选加到全局还是本窗口。命令可勾「带回车」(点一下直接执行,末尾带 ⏎);按键用 ⌃⇧⌥ + 一个基键拼出组合键(如 Ctrl+C),点一下直接发到终端。',
        '聊天模式的快捷条也能自定义了:末尾同样是 ⚙,点开编辑器,「消息/按键」两个 Tab —— 消息就是一句发给 agent 的话(以 / 开头当斜杠命令),按键用同一套 ⌃⇧⌥ + 基键拼组合键(ESC/Tab/退格默认就在里面)。点任意一条可回到弹窗改,▲▼ 排序。',
        '上传体验重做:进度条不再一冲到 100% 就假装完事——先显示真实发送进度,字节发完后转成「服务器接收中…」,大文件不再像卡死。上传中可随时「取消」,已传完的文件会保留。',
        '重名不再报错:上传一个已存在的文件名会自动改名(如 `报告 (1).pdf`),绝不覆盖原文件。上传失败时也会告诉你具体原因(过大 / 不支持的类型)。',
        '现在可以上传视频了(mp4、mov、webm 等)。',
        'Git 面板现在能打开 `/tmp` 等家目录以外的仓库(比如 agent 在 /tmp 里干活的项目),不再报红。',
        '用量进度条新增「时间竖线」:标出当前重置窗口已过去的时间比例。已用量在竖线左边=烧得比时间慢(稳),越过竖线=烧得偏快,一眼看出自己的节奏。',
        '新增版本更新提示:每次打开检测一次,服务端落后于 npm 最新版时设置齿轮亮红点,进设置能看到当前/最新版本号,按提示在电脑上跑 `handmux update` 升级即可。',
      ],
      en: [
        'Command mode\'s saved commands now split into "Global" and "This window": the quick-bar shows global ones (grey) first, then this window\'s (green). The trailing ＋ is now a ⚙ opening a taller two-section editor, each reorderable with ▲▼. One add row does it all: a big Command/Key tab picks the type, a left switch picks which list it lands in. Commands can tick "Send Enter" (a tap runs it, marked ⏎); keys are built from ⌃⇧⌥ + a base key into a combo like Ctrl+C that fires straight into the terminal.',
        'Chat mode\'s quick-bar is now customizable too: the same ⚙ at the end opens an editor with a Message/Key tab — a message is a line sent to the agent (starts with / for a slash-command), a key is built from the same ⌃⇧⌥ + base-key picker (ESC/Tab/Backspace ship as defaults). Tap any row to re-open the card and edit it, ▲▼ to reorder.',
        'Upload redone: the bar no longer jumps to 100% and then hangs — it shows real send progress, then flips to “receiving on the server…” once bytes are flushed, so a big file no longer looks stuck. You can Cancel mid-upload; already-uploaded files are kept.',
        'Name clashes no longer fail: uploading an existing name auto-renames (e.g. `report (1).pdf`) and never overwrites. Failures now tell you why (too large / unsupported type).',
        'Video files can now be uploaded (mp4, mov, webm, …).',
        'The git panel can now open repos outside your home directory (e.g. a project an agent is working in under `/tmp`) instead of erroring.',
        'Usage bars now show a "time marker": a thin vertical line at how far the current reset window has elapsed. Usage left of the line = you\'re burning slower than the clock; past it = faster — pacing at a glance.',
        'New update notice: checked once each time you open the app — when the server is behind the latest npm release, the settings gear lights a dot and Settings shows the current/latest version so you can run `handmux update` on your computer.',
      ],
    },
  },
  {
    version: '0.7.0',
    date: '2026-07-03',
    highlight: { zh: '新增「用量」页', en: 'New "Usage" page' },
    items: {
      zh: [
        '新增「用量」页(顶栏仪表盘图标):一眼看 Claude 的 5 小时 / 本周额度进度条 + 重置倒计时,以及 Codex 的额度环。全部读主机本地文件,不登录账号、不调用 API。Codex 零配置即用;Claude 的实时额度需要在电脑上运行一次 handmux hooks install(会装一个 statusLine 捕获器,已有自定义 statusLine 的绝不覆盖)。',
      ],
      en: [
        'New "Usage" page (gauge icon in the top bar): see Claude\'s 5-hour / weekly limit bars with reset countdowns, plus Codex\'s quota ring — at a glance. All read from local files on the host: no account login, no API calls. Codex works with zero setup; Claude\'s live limits need a one-time `handmux hooks install` on the computer (it adds a statusLine capturer and never clobbers an existing custom statusLine).',
      ],
    },
  },
  {
    version: '0.6.0',
    date: '2026-07-02',
    highlight: { zh: '新增 Codex 支持', en: 'Codex support added' },
    items: {
      zh: [
        '新增 Codex 支持:收件箱与推送现在同时认得 Claude 和 Codex——Codex 会话的「进行中 / 需要你 / 已完成」都会像 Claude 一样推到手机;tmux 外跑着的 Codex 会话也能一键「接管」进来(codex resume);新建会话的启动命令预设新增 codex。收件箱每一条、以及顶栏当前会话,都带上 Claude / Codex 标记,一眼区分是哪种 agent。',
        '会话抽屉底部新增「未接管会话」:一眼看到在 tmux 外跑着、手机还控制不了的 Claude / Codex（带状态、时间、最后一条消息），点「接管」即可在 tmux 里续接同一会话——自动加进会话列表并跳进去,以后手机随时回来。',
      ],
      en: [
        'Added Codex support: the inbox and push now recognize both Claude and Codex — a Codex session\'s working / waiting-on-you / done states reach your phone just like Claude. You can take over Codex sessions running outside tmux (codex resume), and there\'s a new codex startup-command preset. Every inbox row and the current-session topbar now carry a Claude / Codex mark so you can tell the two apart at a glance.',
        'The session drawer now has a "not taken over" section at the bottom: Claude / Codex sessions running outside tmux that your phone can\'t steer yet (with their state, time, and last message). Tap Take over to resume the same conversation inside tmux — it\'s added to your session list and opened, so you can return to it from your phone anytime.',
      ],
    },
  },
  {
    version: '0.5.0',
    date: '2026-06-28',
    highlight: { zh: '首个公开版 · 多语言界面', en: 'First public release · multi-language UI' },
    items: {
      zh: [
        '首个公开发布版本(npm 上的 handmux)。',
        '新增繁体中文、日语、韩语界面（设置 → Language 切换）。',
        '想法角标：有未完成想法时，灯泡图标右上角显示数量。',
        '设置面板列数调节：实时显示当前列数，新增 ±1 精细调节按钮。',
      ],
      en: [
        'First public release (handmux on npm).',
        'Added Traditional Chinese, Japanese, and Korean UI (Settings → Language to switch).',
        'Idea badge: when there are pending ideas, the lightbulb icon shows a count in the corner.',
        'Settings column control: shows the current column count live, with new ±1 fine-adjust buttons.',
      ],
    },
  },
  {
    // Pre-1.0 internal builds (2026-06), merged — the major user-felt features that landed before the
    // first public npm release. No version number: these were never published as their own releases.
    date: '2026-06',
    label: { zh: '早期内测', en: 'Early builds' },
    highlight: { zh: '早期内测', en: 'Early builds' },
    items: {
      zh: [
        '新增「Git」面板(顶栏图标):仿 VS Code,一页同屏看变更 + 提交历史,点文件/提交看全屏彩色 diff;只读,不动你的工作树。可绑多个目录用 tab 切换。',
        '新增「想法」管理器(顶栏灯泡):按窗口记待办,可编辑、拖拽排序、一键填入、语音输入。',
        '网站预览:选目录预览静态站点,或填端口预览本机正在跑的服务(走专属子域名);图片预览:文件/终端里点图片(含 GIF)直接内嵌打开,可捏合缩放、长按保存。',
        '文件:上传/下载(进度条、系统分享上传),浏览器打开即落到当前会话目录,支持 /tmp、$TMPDIR;文档在应用内预览 Markdown/txt/log/sh,可语音朗读(逐句高亮)。',
        '收件箱 + Web Push:汇总各会话「进行中/已完成/需要你」,窗口标签带状态色点,需要你时推送到手机。',
        '命令面板:常用 + 每会话最近命令,斜杠命令快捷键(/clear、/compact、/model…)。',
        '可靠性:断线重连(退避 + 每请求超时 + 断线横幅,后台自动暂停轮询),离线兜底页。',
        '首版:手机浏览器驱动真实 tmux 面板(xterm 终端 + 会话/窗口/pane 导航 + 深链),移动按键区、键盘自动抬升、列宽/字号调节,可添加到主屏(PWA)。',
      ],
      en: [
        'New "Git" panel (top-bar icon): VS Code style — changes + commit history on one screen, tap a file/commit for a full-screen colored diff; read-only, never touches your working tree. Bind multiple dirs and switch via tabs.',
        'New "Ideas" manager (top-bar lightbulb): per-window to-dos — edit, drag to reorder, one-tap insert, voice input.',
        'Website preview: pick a directory for a static site, or a port for a service running locally (dedicated subdomain); image preview: tap an image (including GIFs) in Files or the terminal to open inline, pinch to zoom, long-press to save.',
        'Files: upload/download (progress bar, share-to-upload), the browser opens straight to the current session dir, /tmp and $TMPDIR supported; documents preview in-app (Markdown/txt/log/sh) and can be read aloud (sentence-by-sentence highlight).',
        'Inbox + Web Push: summarizes each session\'s In-progress / Done / Needs-you, window tabs get a status color dot, and Needs-you pushes to your phone.',
        'Command panel: frequent + per-session recent commands, slash-command shortcuts (/clear, /compact, /model, …).',
        'Reliability: reconnect on disconnect (backoff + per-request timeout + connection-lost banner, polling auto-paused in the background) and an offline fallback page.',
        'First release: a phone browser drives real tmux panes (xterm terminal + session/window/pane navigation + deep links), a mobile key bar, keyboard auto-lift, column-width/font-size adjustment, and add-to-home-screen (PWA).',
      ],
    },
  },
];

// Stable id for the unread-dot: the version when public, else the date. LATEST_RELEASE is the top entry's id.
export const entryId = (e) => e.version || e.date;
export const LATEST_RELEASE = CHANGELOG[0] ? entryId(CHANGELOG[0]) : null;
