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
