// User-facing changelog — newest first. Hand-curated (concise "what changed" lines, user-felt
// highlights, not git noise); add an entry when shipping a feature. `v` is the entry's stable id
// used for the unread dot (storage's tw_changelog_seen holds the last v the user opened); `date`
// is what's shown. `items` is now { zh, en } — parallel arrays (same order/count) for each locale.
export const CHANGELOG = [
  {
    v: '2026-07-04-usage-timeline',
    date: '2026-07-04',
    items: {
      zh: [
        '用量进度条新增「时间竖线」:标出当前重置窗口已过去的时间比例。已用量在竖线左边=烧得比时间慢(稳),越过竖线=烧得偏快,一眼看出自己的节奏。',
        '命令模式的常用命令分成「全局」和「当前窗口」两组:快捷栏里全局的(灰)排前、当前窗口的(绿)排后。尾部改成 ⚙ 齿轮,点开更高的编辑器分两区,各自 ▲▼ 排序;添加时可勾「带回车」——带回车的点一下直接执行(末尾带 ⏎),不带的只把命令打进 shell。',
      ],
      en: [
        'Usage bars now show a "time marker": a thin vertical line at how far the current reset window has elapsed. Usage left of the line = you\'re burning slower than the clock; past it = faster — pacing at a glance.',
        'Command mode\'s saved commands now split into "Global" and "This window": the quick-bar shows global ones (grey) first, then this window\'s (green). The trailing ＋ is now a ⚙ opening a taller two-section editor, each reorderable with ▲▼; when adding you can tick "Send Enter" — a with-Enter command runs on one tap (marked with a trailing ⏎), a plain one just types into the shell.',
      ],
    },
  },
  {
    v: '2026-07-03-usage',
    date: '2026-07-03',
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
    v: '2026-07-02-codex',
    date: '2026-07-02',
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
    v: '2026-06-28-i18n-ui',
    date: '2026-06-28',
    items: {
      zh: [
        '新增繁体中文、日语、韩语界面（设置 → Language 切换）',
        '想法角标：有未完成想法时，灯泡图标右上角显示数量',
        '设置面板列数调节：实时显示当前列数，新增 ±1 精细调节按钮',
      ],
      en: [
        'Added Traditional Chinese, Japanese, and Korean UI (Settings → Language to switch)',
        'Idea badge: when there are pending ideas, the lightbulb icon shows a count in the corner',
        'Settings column control: shows the current column count live, with new ±1 fine-adjust buttons',
      ],
    },
  },
  {
    v: '2026-06-20-claude-hooks',
    date: '2026-06-20',
    items: {
      zh: [
        '收件箱:第一次打开若还没接上 Claude Code 通知,会引导你一键开启——开了之后每个 Claude pane 才会标注「进行中 / 需要你 / 已完成」并在需要你时推送。没装 Claude Code 则不打扰。',
      ],
      en: [
        'Inbox: the first time you open it without Claude Code notifications wired up, it walks you through turning them on with one tap — only then does each Claude pane get tagged working / needs you / done and push when it needs you. If you don\'t use Claude Code, it stays out of your way.',
      ],
    },
  },
  {
    v: '2026-06-19-logo',
    date: '2026-06-19',
    items: {
      zh: [
        '全新 App 图标:一部手机正向外发射信号、屏上是跳动的终端光标——「在手中,随处续写」的 handmux。重新添加到主屏即可看到新图标。',
        '文件:除了主目录,现在还能进系统临时目录 /tmp 和 $TMPDIR 查看 / 上传 / 下载文件——路径栏最前面那个固定的 ~ 前缀改成了下拉,点一下即可在 家目录 / tmp / TMPDIR 之间切换。临时文件不用先挪进主目录了。',
        '文件:打开文件特别多的目录更快了(不再逐个等文件信息),且最多只渲染前 300 项、其余在底部提示「在路径框输入关键词筛选」——既不卡也好找。',
        '目录选择器:新建窗口、定位文档基准目录时多了「跳到会话目录」按钮;查看类的选择框(Git 绑定、网站预览)不再显示「新建文件夹」——选目录就只选,不误操作。',
        '文件:返回键改为逐层返回——正在预览文件时,返回先回到该文件所在的目录;在目录里则返回上一级路径;到顶层才退出文件面板,不再一下子整个关掉。',
        '文件:.txt / .log / .sh 现在也能像 Markdown 一样直接在应用内预览(原样等宽显示、可 A−/A+ 调字号),终端里这些路径也可点开。',
      ],
      en: [
        'New app icon: a phone beaming your live session outward, a blinking terminal cursor on its screen — handmux, "in your hand, anywhere." Re-add to your home screen to see it.',
        'Files: beyond your home dir, you can now browse / upload / download in the system temp dirs /tmp and $TMPDIR — the fixed ~ prefix at the start of the path bar is now a dropdown to switch between home / tmp / TMPDIR. No need to move transient files into home first.',
        'Files: very full directories open much faster (no more waiting on each file one by one), and at most the first 300 rows render — the rest are summarized at the bottom with "type in the path box to filter," so it neither lags nor overwhelms.',
        'Directory pickers: a "jump to session dir" button now shows when creating a new window or locating a document\'s base dir; view-type pickers (Git bind, website preview) no longer show "new folder" — picking a dir just picks, nothing to misfire.',
        'Files: Back now steps back one level — while previewing a file it returns to that file\'s folder; inside a folder it returns to the previous path; only at the top does it close the file panel, instead of dismissing the whole thing at once.',
        'Files: .txt / .log / .sh files now preview in-app just like Markdown (shown verbatim in monospace, with A−/A+ font sizing), and such paths are tappable in the terminal.',
      ],
    },
  },
  {
    v: '2026-06-18',
    date: '2026-06-18',
    items: {
      zh: [
        '新增「Git」面板(顶栏图标):仿 VS Code,一页同屏——「变更」在上、「提交」占据主区(默认 20 条、滚到底自动续),两区都可折叠;顶部单独一行——左显示当前分支,右侧下拉可切换查看任意分支的提交历史(只读,不会 checkout、不动你的工作树)。点文件或某次提交看全屏彩色 diff(右上角 A−/A+ 可调字体大小,设置会记住)。可绑定多个目录(前后端分仓)用顶部 tab 切换,每个窗口各自一套。只读,不影响仓库。',
        '图片查看:双指捏合缩放、放大后单指拖动、双击放大/复位(也有 +/− 按钮兜底);长按图片可「保存图片 / 分享图片」。',
        '在设置 / 想法 / 收件箱 / 会话抽屉 / 常用命令等各面板里,手机返回键现在是「退回上一层」而不是直接退出应用。',
      ],
      en: [
        'New "Git" panel (top-bar icon): VS Code style, all on one screen — "Changes" on top, "Commits" filling the main area (20 by default, auto-loads more on scroll), both sections collapsible; a dedicated top row shows the current branch on the left, with a dropdown on the right to view any branch\'s commit history (read-only — never checks out or touches your working tree). Tap a file or commit for a full-screen colored diff (A−/A+ in the top-right adjusts font size, remembered in settings). You can bind multiple directories (separate front/back-end repos) and switch via top tabs, each window with its own set. Read-only, never affects the repo.',
        'Image viewer: pinch to zoom, one-finger drag when zoomed, double-tap to zoom/reset (with +/− buttons as a fallback); long-press an image to "Save image / Share image".',
        'Across Settings / Ideas / Inbox / session drawer / frequent commands and other panels, the phone Back button now "goes back one level" instead of exiting the app outright.',
      ],
    },
  },
  {
    v: '2026-06-17-image-viewer',
    date: '2026-06-17',
    items: {
      zh: [
        '网站预览:选目录预览静态站点,或填端口预览本机正在跑的服务(动态预览走专属子域名,前端路由/接口/HMR 一致)。预览在应用内弹窗打开,可切手机/电脑视图并整体缩放,链接 1 小时有效、可续期。',
        '图片预览:在「文件」或终端里点图片(含 GIF)直接内嵌打开。',
        '新增「想法」管理器(顶栏灯泡):按窗口记待办,可编辑、拖拽排序、一键填入、语音输入;更新日志有新功能时齿轮亮红点。',
      ],
      en: [
        'Website preview: pick a directory to preview a static site, or enter a port to preview a service running locally (dynamic preview uses a dedicated subdomain, keeping front-end routing/API/HMR consistent). Preview opens in an in-app popup, can switch between phone/desktop views and zoom the whole page; links are valid for 1 hour and renewable.',
        'Image preview: tap an image (including GIFs) in "Files" or the terminal to open it inline.',
        'New "Ideas" manager (top-bar lightbulb): keep to-dos per window — edit, drag to reorder, one-tap insert, voice input; the gear lights a red dot when the changelog has new features.',
      ],
    },
  },
  {
    v: '2026-06-16-upload-tts',
    date: '2026-06-16',
    items: {
      zh: [
        '聊天框 ＋ 号上传文件，支持多选，自动填入路径',
        '斜杠命令快捷键：/loop、/skill',
        '文档语音朗读（浏览器 TTS，逐句高亮跟读）',
      ],
      en: [
        'Upload files via the ＋ button in the chat box — multi-select supported, paths auto-filled in',
        'Slash-command shortcuts: /loop, /skill',
        'Read documents aloud (browser TTS, with sentence-by-sentence highlight follow-along)',
      ],
    },
  },
  {
    v: '2026-06-15-files',
    date: '2026-06-15',
    items: {
      zh: [
        '文件浏览器每个文件加「复制绝对路径」按钮',
        '终端长按选择加拖动引导，不再只复制到一个词',
        '文档目录改用浏览选择，不用手输路径',
      ],
      en: [
        'Added a "Copy absolute path" button to each file in the file browser',
        'Long-press selection in the terminal now has a drag guide — no longer copies just a single word',
        'Pick the docs directory by browsing instead of typing the path by hand',
      ],
    },
  },
  {
    v: '2026-06-14-input-bar',
    date: '2026-06-14',
    items: {
      zh: [
        '微信式点按语音输入：按一下开始听写、再按停止；录音整框变绿+呼吸动效',
        '输入栏改造：输入框满宽、框内发送 ↑、⌫/⏎ 移到按键区右端',
        '命令面板嵌入输入框左侧，「常用/最近」分区',
        '新建窗口/会话可选启动命令，在指定目录自动跑（如 claude）',
      ],
      en: [
        'WeChat-style tap-to-talk voice input: tap once to start dictation, tap again to stop; the whole box turns green with a breathing animation while recording',
        'Input bar redesign: full-width input field, in-box send ↑, with ⌫/⏎ moved to the right end of the key bar',
        'Command panel embedded on the left of the input field, with "Frequent/Recent" sections',
        'New windows/sessions can take an optional startup command that auto-runs in the chosen directory (e.g. claude)',
      ],
    },
  },
  {
    v: '2026-06-13-file-transfer',
    date: '2026-06-13',
    items: {
      zh: [
        '文件上传/下载：进度条、下载需确认',
        '系统分享到本应用并选位置上传（Android）',
        '文件浏览器打开即落到当前会话目录',
      ],
      en: [
        'File upload/download: progress bar, downloads require confirmation',
        'Share into this app from the system and pick an upload location (Android)',
        'The file browser opens straight to the current session directory',
      ],
    },
  },
  {
    v: '2026-06-12-cursor',
    date: '2026-06-12',
    items: {
      zh: [
        '终端光标精确摆到 Claude 真实位置（reflow 安全）',
        '加回终端滚动惯性（横竖两轴）',
      ],
      en: [
        'Terminal cursor placed precisely at Claude Code\'s real position (reflow-safe)',
        'Restored terminal scroll inertia (both horizontal and vertical axes)',
      ],
    },
  },
  {
    v: '2026-06-11-inbox',
    date: '2026-06-11',
    items: {
      zh: [
        '收件箱：顶栏汇总「进行中/已完成/需要你」各几个',
        '窗口标签加 Claude 状态色点（需要你=红/进行中=蓝/已完成=绿）',
        '推送两态可靠优先：需要你 4h、已完成只在完成那刻推',
      ],
      en: [
        'Inbox: the top bar summarizes how many are "In progress / Done / Needs you"',
        'Window tabs get a Claude status color dot (Needs you = red / In progress = blue / Done = green)',
        'Two-state push, reliability first: "Needs you" for 4h, "Done" pushed only at the moment it completes',
      ],
    },
  },
  {
    v: '2026-06-10-docs',
    date: '2026-06-10',
    items: {
      zh: [
        '文档查看器：Markdown 渲染、点终端里的路径即打开、字号缩放',
        'Web Push：开启设备通知',
        'KeyBar 扩展：/clear、/compact、/model、/btw',
      ],
      en: [
        'Document viewer: Markdown rendering, tap a path in the terminal to open it, font-size zoom',
        'Web Push: enable device notifications',
        'KeyBar additions: /clear, /compact, /model, /btw',
      ],
    },
  },
  {
    v: '2026-06-09-reorder',
    date: '2026-06-09',
    items: {
      zh: [
        '从管理菜单拖动重排窗口（◀ 左移 / 右移 ▶）',
      ],
      en: [
        'Reorder windows by dragging from the manage menu (◀ move left / move right ▶)',
      ],
    },
  },
  {
    v: '2026-06-06-manage',
    date: '2026-06-06',
    items: {
      zh: [
        '长按窗口标签管理：重命名 / 删除',
        '重命名会话/窗口（本地名与历史一并迁移）',
      ],
      en: [
        'Long-press a window tab to manage it: rename / delete',
        'Rename sessions/windows (local name and history migrated along with it)',
      ],
    },
  },
  {
    v: '2026-06-05-sessions',
    date: '2026-06-05',
    items: {
      zh: [
        '从绑定弹窗新建会话',
        '＋ 新建窗口（可命名）',
        '离线兜底页：断网冷启动也有可重试页面',
      ],
      en: [
        'Create a new session from the binding popup',
        '＋ to create a new window (nameable)',
        'Offline fallback page: a retryable page even on a cold start with no network',
      ],
    },
  },
  {
    v: '2026-06-03-reliability',
    date: '2026-06-03',
    items: {
      zh: [
        '断线重连：退避 + 每请求超时 + 断线横幅，后台自动暂停轮询',
        '命令面板：常用 + 每会话最近命令',
      ],
      en: [
        'Reconnect on disconnect: backoff + per-request timeout + a connection-lost banner, polling auto-paused in the background',
        'Command panel: frequent commands + recent commands per session',
      ],
    },
  },
  {
    v: '2026-06-02-pwa',
    date: '2026-06-02',
    items: {
      zh: [
        '可添加到主屏（PWA 安装）',
        '长按选择并复制终端文本',
        '设置面板（列数/字体/退出）与本地会话列表',
      ],
      en: [
        'Add to home screen (PWA install)',
        'Long-press to select and copy terminal text',
        'Settings panel (columns/font/exit) and a local session list',
      ],
    },
  },
  {
    v: '2026-06-01-first',
    date: '2026-06-01',
    items: {
      zh: [
        '首版：手机浏览器驱动真实 tmux 面板',
        'xterm 终端 + 会话/窗口/pane 导航 + 深链',
        '移动按键区（方向键长按连发）、键盘自动抬升、历史浏览、列宽/字号调节',
      ],
      en: [
        'First release: a phone browser drives real tmux panes',
        'xterm terminal + session/window/pane navigation + deep links',
        'Mobile key bar (arrows auto-repeat on long-press), keyboard auto-lift, scrollback browsing, column-width/font-size adjustment',
      ],
    },
  },
];

export const LATEST_RELEASE = CHANGELOG[0]?.v ?? null;
