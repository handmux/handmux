export interface ChangelogEntry {
  version?: string;
  date: string;
  label?: Record<string, string>;
  highlight: Record<string, string>;
  items: Record<string, string[]>;
}

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
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.27.0',
    date: '2026-09-05',
    highlight: {
      zh: '腾讯语音输入 · 终端输入更准确',
      en: 'Tencent voice input · more accurate terminal typing',
    },
    items: {
      zh: [
        '语音输入新增腾讯实时与一句话识别，同时保留讯飞实时识别；三种方案共享实时音量波形与录音动效，识别文字会插入起录时的光标位置，不会清空已有草稿。',
        '语音配置会在首次设置、切换方案或修改字段后直接验证；设置页可调整腾讯语气词过滤级别，关闭语音会保留方案和凭据以便重新开启。',
        '修复语音录制、网络或服务商识别失败时没有提示的问题；未识别出文字时也会明确提示重试。',
        '修复实时终端连续输入英文、中文或使用方向键后偶发双光标或光标停在上一字符的问题；现在文字顺序正确，光标只在正确位置显示一次。',
        '修复 Codex 上下文压缩期间内部摘要短暂闪入正文的问题；工具输入、输出和 Diff 被裁剪时也会在实际位置说明原因。',
      ],
      en: [
        'Voice input adds Tencent real-time and sentence recognition alongside iFlytek real-time recognition. All three share the live level waveform and recording animation, and insert recognized text at the caret captured when recording started without clearing the draft.',
        'Voice configuration is verified after initial setup, a profile switch, or a field edit. Settings can adjust Tencent filler-word filtering, while turning voice off keeps the selected profile and credentials ready for re-enabling.',
        'Fixed voice capture, network, or provider recognition failures producing no visible feedback; an empty recognition result now clearly asks you to retry.',
        'Fixed live terminal typing occasionally showing two cursors or leaving the cursor on the preceding character. English and Chinese typing now stays in order with arrow-key navigation, and the cursor appears only once at the correct position.',
        'Fixed an internal summary briefly flashing into chat during Codex compaction. Truncated tool input, output, and diffs now also explain the limit at the actual cut point.',
      ],
    },
  },
  {
    version: '0.26.0',
    date: '2026-09-04',
    highlight: {
      zh: '对话精细复制 · Pi 上下文状态',
      en: 'Precise chat copy · Pi context status',
    },
    items: {
      zh: [
        '手机端 Agent 对话支持精细复制：长按消息、工具、Diff 或错误文字选词，拖动首尾手柄调整，并可扩展到屏幕整行或语义整段；流式更新和滚动期间也会保留选区。',
        'Pi 对话的上下文圆环现在显示原生实时用量、运行状态和工作目录；升级会可靠刷新 Connector，已在运行的 Pi 会话执行 /reload 后即可获得新能力。',
        '修复 Codex 历史中的 Diff 使用工作区外绝对临时路径时，更早的消息无法加载的问题。',
        '修复 Codex 只读沙箱配合自动审批时，权限模式被误显示为“自定义”的问题。',
        '修复空收件箱被单个异常 Agent pane 的降级状态长期覆盖为“正在重新连接”的问题。',
      ],
      en: [
        'Agent chat now supports precise copying on touch devices: long-press message, tool, diff, or error text to select a word, drag either handle to refine it, or expand to the rendered line or semantic paragraph; selections also survive streaming updates and scrolling.',
        'Pi chat’s context ring now shows native live usage, activity, and working directory. Upgrades reliably refresh the Connector; run /reload in an already-open Pi session to expose the new capability.',
        'Fixed older Codex history failing to load when a diff used an absolute temporary path outside the workspace.',
        'Fixed Codex read-only sandbox with automatic approval being mislabeled as a custom permission mode.',
        'Fixed an empty Inbox being indefinitely replaced by “Reconnecting” when a single Agent pane was degraded.',
      ],
    },
  },
  {
    version: '0.25.2',
    date: '2026-09-02',
    highlight: {
      zh: '修复 Agent 对话断流、排队与工具路径',
      en: 'Fixed Agent chat streams, queues, and tool paths',
    },
    items: {
      zh: [
        '修复 Codex 上下文压缩后回复不再实时显示，以及 Pi 历史推进、授权内容更新或 Bridge 启动失败后，对话可能断开、空白或无法重试的问题。',
        '发送状态未知的排队消息会先沿用原消息 ID 安全重试；若仍无法确认，消息会回到对话中，由你决定是否作为新消息再次发送。',
        '工具输入和输出中的本地路径恢复可读；用户主目录缩写为 ~/，密码、Token、Cookie 和私有地址仍会脱敏。',
        '修复订阅用量卡片操作菜单未靠右，以及再次点击三点按钮不能收起菜单的问题。',
      ],
      en: [
        'Fixed replies no longer streaming after Codex compaction, plus chats disconnecting, going blank, or becoming non-retryable after Pi history advances, authorization updates, or Bridge startup failures.',
        'Queued messages with unknown delivery now retry under their original message ID first; if delivery still cannot be confirmed, the message returns to the conversation so you can choose whether to send it again as new.',
        'Local paths in tool input and output are readable again. User home directories are shortened to ~/, while passwords, tokens, cookies, and private endpoints remain redacted.',
        'Fixed subscription-usage action menus not aligning to the right and not closing when their three-dot button was tapped again.',
      ],
    },
  },
  {
    version: '0.25.1',
    date: '2026-09-02',
    highlight: {
      zh: '修复 Codex 幽灵任务与对话空白',
      en: 'Fixed Codex ghost tasks and blank chats',
    },
    items: {
      zh: [
        '修复 Codex 自动生成标题或回顾摘要的临时线程被误认成当前会话，导致收件箱批量出现无法完成的幽灵“进行中”、对话页报错后空白的问题；服务重启后会重新绑定真实会话并自动撤销旧假状态。',
      ],
      en: [
        'Fixed Codex title and catch-up helper threads being mistaken for the current conversation, which created ghost “Working” inbox entries and left chat blank after an error. A Server restart now rebinds the real conversation and automatically withdraws stale false states.',
      ],
    },
  },
  {
    version: '0.25.0',
    date: '2026-09-01',
    highlight: {
      zh: 'Pi 原生接入 · 多 Agent 对话更可靠',
      en: 'Native Pi support · more reliable agent chat',
    },
    items: {
      zh: [
        '新增 Pi 原生接入：运行 handmux agent enable pi 显式启用接入，以后用 handmux pi 日常启动原生 TUI；Handmux 离线时 Pi 仍可正常使用，结果会在本机等待重放。Pi 对话需在设置中独立开启，当前仍为实验性功能。',
        'Claude Code、Codex 与 Pi 统一接入新的 Agent Runtime：多 pane 状态、完成与出错通知、跨设备已读和实时对话现在由同一套持久数据链提供。',
        '用量页支持单独刷新订阅；Codex 可查看账号、套餐与细分额度，API 分栏可在本机加密保存多个 DeepSeek 和 Moonshot (Kimi) 账户并读取官方余额。',
        'Codex 对话在长会话、切换 pane、Server 重启和弱网重连时更稳定；新会话首条消息、排队与立即引导、发送失败重试、上下文压缩详情都会原位恢复并持续对账。',
        '重写对话滚动与历史分页：上拉阅读不再被新输出抢回底部或推到页首；桌面复制、键盘焦点、前后台重连和统一错误提示也更符合系统习惯。',
        '文件上传支持 ZIP；中文 Markdown 路径、绝对目录和普通句点不再误判或乱码。会话状态还能直接查看当前 Git worktree 根路径与分支。',
        '最低运行环境提高到 Node.js 22.16；低版本会在启动前得到明确升级提示，Homebrew 安装仍会自动提供所需 Node。开机恢复恰遇 npm 替换 Agent 时会短暂等待安装完成，不再误报未安装或丢失恢复的 pane。',
      ],
      en: [
        'Added native Pi integration. Run handmux agent enable pi once, then use handmux pi for everyday native-TUI launches; Pi remains usable while Handmux is offline, with results queued locally for replay. Pi chat is independently enabled in Settings and remains experimental.',
        'Claude Code, Codex, and Pi now share the new Agent Runtime, with one durable data path for multi-pane state, completion and error notifications, cross-device read state, and live conversations.',
        'Usage subscriptions can now be refreshed individually. Codex shows account, plan, and detailed limits, while the API tab saves multiple DeepSeek and Moonshot (Kimi) accounts encrypted on this computer and reads their official balances.',
        'Codex chat is more reliable across long sessions, pane switches, Server restarts, and weak-network reconnects. First sends, queued and guided messages, safe retries, and context-compaction details now recover and reconcile in place.',
        'Reworked chat scrolling and history pagination so new output no longer steals the reading position or jumps to the top. Desktop copy, keyboard focus, foreground reconnects, and unified error feedback now follow platform conventions more closely.',
        'ZIP uploads are supported. Chinese Markdown paths, absolute directories, and ordinary punctuation no longer become broken links, while session status now shows the current Git worktree root and branch.',
        'The minimum runtime is now Node.js 22.16. Older runtimes receive a clear pre-launch upgrade message, while Homebrew continues to install the required Node automatically. If startup recovery overlaps an npm Agent replacement, Handmux briefly waits for installation instead of falsely reporting the Agent missing or losing restored panes.',
      ],
    },
  },
  {
    version: '0.24.0',
    date: '2026-08-11',
    highlight: {
      zh: 'Codex 任务进度与 Goal 原生上线',
      en: 'Native Codex task progress and Goals',
    },
    items: {
      zh: [
        'Codex 对话新增只读回合任务列表：当前运行步骤带动态状态，点按可用 Bottom Sheet 查看完整计划；回合结束后保留可恢复的任务摘要。',
        'Goal 现在完整融入对话：设置或重新开始会立即创建并启动新目标，进行中或暂停的目标常驻在任务列表下方，历史状态留在对应回合；统一详情支持编辑后重新开始、暂停、继续与清除。',
        '终端与对话可预览任意扩展名的文本文件；打开前会按内容区分文本与二进制，普通斜杠文字和未知 Markdown 目标不再误变成可点击路径。',
        '修复了发送消息后回复偶尔排到用户消息上方，以及主屏 App 从其他应用返回后终端或 Codex 对话可能停在旧画面的问题。',
        'Server、Web 与 CLI 底层完成严格 TypeScript 迁移，发布包改为只运行编译产物，并补强了私密状态、会话队列、服务恢复与错误边界。',
      ],
      en: [
        'Added a read-only turn task list to Codex chat: the active step carries a live indicator, the full plan opens in a Bottom Sheet, and a restorable task summary remains after the turn.',
        'Goals now live naturally in chat: setting or restarting creates and starts a fresh Goal immediately, active or paused Goals stay below the task list, and history stays with its original turn; one shared detail sheet supports edit-and-restart, pause, resume, and clear.',
        'Preview text files with any extension from terminal or chat. A content check separates text from binary files, while slash-separated prose and unknown Markdown targets no longer become misleading file links.',
        'Fixed replies occasionally appearing above the user message that started them, and terminal or Codex chat getting stuck on an old screen after returning to the installed app.',
        'Migrated the Server, Web app, and CLI internals to strict TypeScript, made release packages run compiled output only, and strengthened private state, session queues, service recovery, and API error boundaries.',
      ],
    },
  },
  {
    version: '0.23.0',
    date: '2026-08-09',
    highlight: {
      zh: 'Codex 托管对话正式上线',
      en: 'Managed Codex chat is here',
    },
    items: {
      zh: [
        '新增 Codex 托管对话视图：手机与终端保持同一会话，可实时查看 Markdown 回复、完整工具调用、提问与审批，并直接停止任务；断线或重新打开后仍能恢复完整对话。',
        '可用 handmux codex 直接启动托管会话，也可从普通 Codex 窗格原位接管并恢复准确会话；需要终端确认时会明确提示。',
        'Codex 回复期间可继续发送消息：默认按条排队到后续回合，也可编辑、删除或立即引导当前回复。',
        '输入区可直接调整模型、思考强度、Fast 和权限，查看上下文与会话状态，并使用 /goal、/compact、/clear；回复中的文件与网址也可直接在应用内打开。',
        'Codex 与 Claude Code 对话开关现已分开；Codex 正式支持托管对话，Claude Code 对话仍为独立的实验性功能。',
        '修复了应用长时间切到后台后不刷新、多窗格面板受网络阻塞，以及 iPhone 软键盘可能导致终端尺寸异常的问题。',
      ],
      en: [
        'Added managed Codex chat: the phone and terminal stay on the same session, with live Markdown replies, complete tool calls, questions, approvals and stopping; the full conversation recovers after a disconnect or reopen.',
        'Start a managed session with handmux codex, or take over a plain Codex pane in place and resume its exact session; Handmux clearly asks you to switch to the terminal when confirmation is needed.',
        'Keep sending while Codex is working: messages queue one by one for later turns, or can be edited, deleted, or guided into the current turn immediately.',
        'Change the model, reasoning effort, Fast and permissions from the composer, inspect context and session status, use /goal, /compact and /clear, and open files or URLs from replies directly in the app.',
        'Codex and Claude Code chat now have separate switches: managed Codex chat is fully supported, while Claude Code chat remains an independent experimental feature.',
        'Fixed stale state after a long app switch, network-blocked multi-pane panels, and iPhone soft-keyboard transitions that could leave the terminal at the wrong size.',
      ],
    },
  },
  {
    version: '0.22.1',
    date: '2026-08-04',
    highlight: {
      zh: '网页宽度与网站版本分开控制',
      en: 'Separate page width and site-version controls',
    },
    items: {
      zh: [
        '网页预览器将窄屏 / 宽屏与手机版 / 电脑版分开：宽度切换不重载页面，电脑代理可另外向网站请求所需版本并保留登录状态。',
        '修复了电脑代理临时重启、会话过期或丢失后可能停在错误页的问题，当前标签现在会自动恢复。',
      ],
      en: [
        'Web Preview now separates narrow/wide page width from mobile/desktop site requests: width changes do not reload, while computer proxy tabs can request a site version and keep their sign-in state.',
        'Fixed proxy tabs getting stuck on an error page after the computer proxy restarted or a browser session expired or disappeared; the current tab now recovers automatically.',
      ],
    },
  },
  {
    version: '0.22.0',
    date: '2026-08-03',
    highlight: {
      zh: '全屏设置 · 窗口与分屏管理更清晰',
      en: 'Full-screen Settings · clearer window and pane management',
    },
    items: {
      zh: [
        '设置改为全屏分组页面：常用选项使用统一的二级页，版本、更新日志、反馈和重新加载应用集中在首层。',
        '列宽调整移到对应的窗口管理或窗格管理中；单窗格调整窗口宽度，多窗格只调整所选窗格，并可恢复自动宽度或原分屏比例。',
        '推送通知、脚本推送和脚本推送记录的入口重新整理；关闭通知前会先确认，同一 App 安装重新开启后仍保留原设备 key。',
        '修复了冷启动时实时终端先显示快照，以及重启后从最近访问打开静态目录产生重复标签的问题。',
      ],
      en: [
        'Settings is now a full-screen grouped page with consistent detail views, while version, changelog, feedback, and Reload app stay on the first level.',
        'Column sizing now lives in Window or Pane Management: resize a single-pane window or the selected pane in a split, then restore automatic width or the original split ratio.',
        'Push notifications, Script push, and Script Push History are arranged more clearly; turning notifications off requires confirmation, and re-enabling keeps the same device key for that app installation.',
        'Fixed live terminals briefly starting in snapshot mode and static directories opening as duplicate tabs from Recently Visited after a restart.',
      ],
    },
  },
  {
    version: '0.21.0',
    date: '2026-08-03',
    highlight: {
      zh: '网页预览：手机直连、电脑代理与静态目录',
      en: 'Web preview: direct, computer proxy, and static folders',
    },
    items: {
      zh: [
        '新增常驻网页预览器：可由手机直连开发服务、localhost、内网和允许嵌入的网站，也可在配置 previewDomain 后经电脑代理访问；静态目录预览也已融合到同一界面。',
        '网址和静态目录现在使用统一的持久标签与最近访问；切换标签会保留页面、滚动和表单状态，支持手机/电脑视图、网页缩放、刷新、停止及用系统浏览器打开。',
        '电脑代理支持按设备隔离的 Cookie Profile，可在相关企业系统间复用 SSO Cookie，并可选择加密持久化、按网站清理或全部清理。',
        '运行 handmux 的最低 Node.js 版本由 18 提升至 20；网页电脑代理使用的底层依赖要求 Node.js 20。',
      ],
      en: [
        'Added a persistent Web Preview for direct phone access to development services, localhost, intranet pages, and sites that allow embedding, plus computer proxy access after previewDomain is configured; static folders now share the same interface.',
        'URL and static-folder previews now use unified persistent tabs and recent history; switching tabs preserves page, scroll, and form state, with mobile/desktop views, page zoom, refresh, stop, and Open in system browser.',
        'Computer proxy mode supports a device-isolated Cookie Profile that can reuse SSO cookies across related enterprise systems, with optional encrypted persistence and per-site or full cleanup.',
        'The minimum Node.js version for running handmux increased from 18 to 20 because the computer proxy\'s underlying dependency requires Node.js 20.',
      ],
    },
  },
  {
    version: '0.20.3',
    date: '2026-08-01',
    highlight: {
      zh: '实时终端显示更稳定流畅',
      en: 'More stable, smoother live terminals',
    },
    items: {
      zh: [
        '修复了实时终端持续输出时偶发缺行,以及内容较短、首次打开或展开键盘时画面位置不稳定的问题;长时间使用和多窗口同时打开也更流畅。',
      ],
      en: [
        'Fixed occasional missing lines during continuous live output and unstable positioning with short content, first open, or keyboard expansion; long sessions and multiple visible windows also stay smoother.',
      ],
    },
  },
  {
    version: '0.20.2',
    date: '2026-07-27',
    highlight: {
      zh: '实时终端长时间运行更流畅',
      en: 'Smoother long-running live terminals',
    },
    items: {
      zh: [
        '实时终端长时间打开、连续输出大量内容或电脑同时显示多个 PWA 时保持流畅;输出积压时会跳过过期画面并同步最新终端状态,tmux 历史仍可继续查看。',
      ],
      en: [
        'Live terminals stay responsive during long sessions, heavy output, and multiple visible PWAs; stale intermediate frames are skipped when output falls behind, while the latest tmux state and scrollback remain available.',
      ],
    },
  },
  {
    version: '0.20.1',
    date: '2026-07-26',
    highlight: {
      zh: '聊天发送修复 · 电脑键盘不中断',
      en: 'Reliable chat sending · uninterrupted desktop input',
    },
    items: {
      zh: [
        '电脑端焦点落在 Window 工具栏后,物理键盘输入和 Shift+Enter 仍会作用于当前终端;F5、F12 保留给浏览器。',
        '修复了聊天模式选择文件后没有开始上传、快速连按重复发送同一条内容的问题;空内容发送 Enter 的能力保持不变。',
      ],
      en: [
        'Physical keyboard input and Shift+Enter keep working after focus lands on the Window toolbar; F5 and F12 remain available to the browser.',
        'Fixed chat uploads not starting after file selection and rapid taps sending the same content more than once; sending Enter with an empty composer remains available.',
      ],
    },
  },
  {
    version: '0.20.0',
    date: '2026-07-26',
    highlight: {
      zh: '终端实时推送 · 弱网自动回退',
      en: 'Live terminal pushing · automatic network fallback',
    },
    items: {
      zh: [
        '手机和电脑的终端输出现在通过 WebSocket 实时推送;首次打开即可上滑浏览最近的 tmux 历史,继续上滑会加载更早内容,回到底部后重新同步最新画面。',
        '实时连接不可用或持续较差时会自动回退到快照拉取,稳定 30 秒后尝试恢复;右上角显示当前模式与延迟,设置中也可固定使用快照拉取并选择刷新频率。',
        '设置中新增「重新加载应用」,服务端更新后无需退出主屏应用即可载入新版客户端;设置二级页面和弹窗现在会按层返回。',
      ],
      en: [
        'Terminal output now uses WebSocket live pushing on phone and desktop; scroll up immediately for recent tmux history, keep scrolling for older content, and return to the bottom to resynchronize the latest screen.',
        'An unavailable or persistently poor live connection automatically falls back to snapshot pulling and retries after 30 stable seconds; the top-right status shows the current mode and latency, while Settings can pin snapshot pulling and choose its refresh rate.',
        'Settings now includes Reload app, so an updated server can load the new client without quitting the home-screen app; nested Settings pages and dialogs also return one layer at a time.',
      ],
    },
  },
  {
    version: '0.19.0',
    date: '2026-07-25',
    highlight: {
      zh: '电脑物理键盘直输 · Window 切换更流畅',
      en: 'Desktop keyboard input · faster window switching',
    },
    items: {
      zh: [
        '电脑浏览器现在可以用物理键盘直接操作终端,并支持常用终端快捷键、输入法和复制粘贴;Shift+Enter 可进入保留快捷用语、上传、历史和语音的草稿模式,设置中也可手动指定手机或电脑键盘模式。',
        '全站滚动条现在更统一;终端内容超宽时会显示独立横向滚动条,网络较慢时切换 Window 也会立即进入目标终端的加载页面。',
        'Agent 用量现在稳定展示所有设备共享的本机最新状态,Codex 主额度与 CLI /status 保持一致。',
      ],
      en: [
        'Desktop browsers can now drive the terminal directly from a physical keyboard, with common terminal shortcuts, IME, and copy/paste; Shift+Enter opens draft mode with shortcuts, uploads, history, and voice intact, and Settings can force Mobile or Desktop keyboard mode.',
        'Scrollbars are now consistent across the app; wide terminal content gets its own horizontal scrollbar, and switching Windows on a slow network enters the target terminal loading view immediately.',
        'Agent usage now keeps the latest machine state stable and shared across devices, while the main Codex quota matches CLI /status.',
      ],
    },
  },
  {
    version: '0.18.0',
    date: '2026-07-22',
    highlight: {
      zh: 'Tmux 工作区恢复 · 快捷栏自由定制',
      en: 'Tmux workspace recovery · customizable shortcuts',
    },
    items: {
      zh: [
        '新增 Tmux 工作区恢复:电脑或 Tmux 重启后,可从手机或 handmux restore 恢复上次的会话、窗口、分屏、目录和布局;Claude Code / Codex 会话还能继续原对话。',
        '新增 handmux shortcuts:可分别配置命令与聊天模式的共享快捷项;每台手机也能自由混排共享与本机项,或只在本机移除共享项。',
        'handmux setup 现在可以配置动态预览域名;预览不再自动续期,需要延长时由你手动续期或重新打开。',
      ],
      en: [
        'Added Tmux workspace recovery: after the computer or Tmux restarts, restore the previous sessions, windows, panes, working directories, and layouts from the phone or handmux restore; Claude Code and Codex sessions can also continue their original conversations.',
        'Added handmux shortcuts to configure shared command-mode and chat-mode items; each phone can also freely mix shared and local items or remove a shared item only on that device.',
        'handmux setup can now configure the dynamic-preview domain; previews no longer renew automatically and can be extended manually or reopened when needed.',
      ],
    },
  },
  {
    version: '0.17.8',
    date: '2026-07-20',
    highlight: {
      zh: '分屏地图显示尺寸 · iPhone 交互修复',
      en: 'Pane dimensions in the map · iPhone interaction fixes',
    },
    items: {
      zh: [
        '分屏地图现在会在空间足够的窗格里低调显示真实终端尺寸（列×行）,较小窗格仍保持简洁。',
        '修复了分屏地图在 iPhone 上无法显示、长按窗格时触发系统文字选择的问题。',
        '设置分屏列宽时现在会读取当前窗格的实际宽度,不同窗格不再互相沿用调整值。',
      ],
      en: [
        'The pane map now quietly shows each terminal\'s real columns × rows when space allows, while smaller tiles stay uncluttered.',
        'Fixed the pane map failing to appear on iPhone and long-pressing a pane triggering the system text-selection UI.',
        'Pane-width settings now read the active pane\'s actual width, so adjustments no longer carry over between panes.',
      ],
    },
  },
  {
    version: '0.17.7',
    date: '2026-07-20',
    highlight: {
      zh: '单实例启动兜底 · WSL 状态命令修复',
      en: 'Single-instance startup guard · WSL status fix',
    },
    items: {
      zh: [
        '修复安装开机自启后升级、重启可能产生两个后台实例,导致端口占用、URL 不出现或 stop 后仍可访问的问题;启停命令现在统一管理同一个服务,发现重复副本会列出 PID 并全部回收。',
        'handmux status 现在显示实际运行版本,升级后可区分已安装版本;修复了 WSL 中内容显示完毕却不返回命令行的问题。',
      ],
      en: [
        'Fixed upgrades or restarts creating two background instances after autostart was installed, which could occupy the port, hide the URL, or remain reachable after stop; lifecycle commands now manage one service and list/reap every duplicate PID.',
        'handmux status now shows the actual running version and distinguishes a newly installed version; fixed WSL terminals not returning to the prompt after status output completed.',
      ],
    },
  },
  {
    version: '0.17.6',
    date: '2026-07-20',
    highlight: {
      zh: '推送结果可追踪 · 对话与权限操作更可靠',
      en: 'Traceable push results · safer chats and permissions',
    },
    items: {
      zh: [
        '脚本通知现在会按设备显示成功或失败,失败详情会区分订阅失效、限流、推送服务不可用、拒绝和网络错误;handmux push 也不会再把零送达或部分失败报告为成功。',
        '修复了关闭通知、打开或删除通知记录、查询设备 key 等操作在浏览器或网络无响应时可能一直等待的问题;关闭本地通知开关现在会立即生效。',
        '长对话轮询不再遍历整段会话;历史记录统一每次加载 20 条,首次打开不足一屏时也会自动继续补取更早内容。',
        '权限确认卡调整为左侧取消、右侧确认;取消需要在 2 秒内再次点击,避免误触中断正在等待的请求。',
      ],
      en: [
        'Script notifications now show success or failure per device, with details for expired subscriptions, rate limits, unavailable push services, rejection, and network errors; handmux push no longer reports zero delivery or partial failure as success.',
        'Fixed notification disabling, inbox loading or deletion, and device-key lookup waiting forever when the browser or network stops responding; the local notification switch now turns off immediately.',
        'Long-chat polling no longer walks the entire session; history loads 20 messages at a time and automatically keeps fetching older messages when the first page does not fill the screen.',
        'Permission cards now place Cancel on the left and Confirm on the right; cancellation requires a second tap within two seconds to prevent accidentally interrupting a pending request.',
      ],
    },
  },
  {
    version: '0.17.5',
    date: '2026-07-20',
    highlight: {
      zh: '通知开启修复 · 长会话与设置可靠性提升',
      en: 'Notification setup fixed · stronger chat and settings reliability',
    },
    items: {
      zh: [
        '修复了安卓 Chrome 开启通知永久转圈、失效订阅假报成功以及更换域名后收不到通知的问题;注册、激活、FCM 与服务器上报现在会分别检查,失效订阅可自动重置。',
        '修复了超长对话反复全量解析、可能拖慢服务并持续占用手机内存的问题;对话记录改为增量读取并限制缓存规模。',
        '恢复设置里的完整版本更新历史;有新版本时的升级提示仍只展示最新一条,更早版本可按需展开。',
        '修复通知记录加载或删除失败时误显示为空、消息短暂消失的问题,现在会保留已有内容并提示重试。',
        '修复 Agent 退出后偶尔残留旧状态、普通 Node 程序被误认成 Codex 的问题;动态预览认证也限制在当前子域,启动失败会显示真实原因。',
      ],
      en: [
        'Fixed Android Chrome notification setup spinning forever, stale subscriptions being reported as enabled, and notifications not arriving after a domain change; registration, activation, FCM, and server reporting are now checked separately, with expired subscriptions reset automatically.',
        'Fixed very long chats being repeatedly parsed in full, which could slow the service and keep growing phone memory use; transcripts now load incrementally with bounded caches.',
        'Restored the complete version history in Settings; the upgrade prompt still shows only the newest release by default, with older versions expandable on demand.',
        'Fixed notification history appearing empty or briefly losing a message when loading or deletion failed; existing content is now preserved with a retry action.',
        'Fixed stale Agent state after exit and ordinary Node programs occasionally being mistaken for Codex; dynamic-preview authentication is now scoped to the current subdomain and startup failures show their real cause.',
      ],
    },
  },
  {
    version: '0.17.4',
    date: '2026-07-19',
    highlight: {
      zh: 'HTTPS 本机预览修复 · 通知链接安全加固',
      en: 'HTTPS localhost previews fixed · safer notification links',
    },
    items: {
      zh: [
        '修复了 HTTPS/WSS 本机服务无法一键预览、带 # 的深链打开失败,以及 Codex pane 偶尔误出现 Claude 对话视图的问题;通知跳转链接也增加了安全校验。',
      ],
      en: [
        'Fixed one-tap previews for local HTTPS/WSS services, deep links with # fragments, and Claude chat view occasionally appearing on a Codex pane; notification links now receive stricter safety checks too.',
      ],
    },
  },
  {
    version: '0.17.3',
    date: '2026-07-19',
    highlight: {
      zh: '三修官方一键安装的 Claude 识别,真机已验证',
      en: 'Third fix for native-install Claude detection, device-verified',
    },
    items: {
      zh: [
        '修复了官方一键安装器版 Claude Code 仍识别不出的问题(0.17.2 的对账依据在真实环境不成立);本次按真机数据修正,已验证所有官方安装方式都能正确识别(agent 图标、对话视图切换钮正常出现)。',
      ],
      en: [
        'Fixed native-installer Claude detection still not working (0.17.2 relied on a signal that doesn\'t hold in the real environment); corrected against real-device data — verified across all official install methods (agent icon and chat-view switch appear).',
      ],
    },
  },
  {
    version: '0.17.0',
    date: '2026-07-18',
    highlight: {
      zh: '对话视图(实验性)· 通知记录 · 本机地址一键预览',
      en: 'Chat view (experimental) · notification inbox · one-tap localhost preview',
    },
    items: {
      zh: [
        '新增「对话视图」(实验性功能,默认关):到设置里打开「启用对话视图(实验性功能)」后,窗口栏就能把 Claude 会话在终端/对话两个视图间一键切换(需已装 Claude hooks,没装可一键安装)。对话视图把会话读成聊天记录——气泡 + Markdown、工具卡(编辑文件带 +A/−B 和彩色 diff)、Claude 提问时点按即答的问题卡、上下文压缩动画、三套暖色配色;终端视图照旧,完全不受影响。',
        '新增「通知记录」:脚本推送(handmux push)的通知按设备留存(各 100 条),全屏翻看、点开看详情、逐条删除;点手机上的通知直接跳到那条消息的详情。',
        '终端里打印的本机地址(localhost:3000 等)自动变成可点的:点一下就能起代理在手机上预览(带路径),多个端口还能并行切换、自动续期。',
      ],
      en: [
        'New chat view (experimental, off by default): enable it in Settings → Enable chat view, then flip a Claude pane between terminal and chat from the window bar (requires Claude hooks — one-tap install offered). The chat view reads the session as a conversation — bubbles with Markdown, tool cards (+A/−B and colored diffs for file edits), question cards you answer with a tap, a visible compaction animation, and three warm colour tones. The terminal view is untouched.',
        'New notification inbox: pushes from handmux push are kept per device (latest 100) — browse full-screen, open details, delete one by one; tapping a push lands on that message’s detail.',
        'Localhost URLs printed in the terminal (localhost:3000, …) are now tappable: one tap proxies and previews them on your phone (path preserved), with several ports open in parallel and auto-renewed.',
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
export const entryId = (entry: ChangelogEntry): string => entry.version || entry.date;
export const LATEST_RELEASE = CHANGELOG[0] ? entryId(CHANGELOG[0]) : null;
