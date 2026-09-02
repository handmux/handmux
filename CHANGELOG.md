# Changelog

All notable changes to handmux. Format follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Added

- Pi 对话接入通用上下文圆环，显示原生实时上下文用量、运行状态和工作目录；旧 Connector 保持聊天可用，执行 `/reload` 后启用新能力。

## [0.25.2] - 2026-09-02

### Fixed

- Agent 对话中的工具输入和输出现在保留可读的本地文件路径，并将用户主目录缩写为 `~/`；密码、Token、Cookie 和 URL 凭证仍会脱敏。
- 发送状态待确认的排队消息现在先用原消息 ID 安全重试；若 Core 已经派发仍无法确认，则移入对话并由用户确认是否作为新消息再次发送。
- 修复 Agent 尚无用量更新时间时，订阅用量卡片的操作菜单没有靠右对齐的问题。
- 修复再次点击已展开的用量菜单按钮时，菜单收起后又被同一次触摸重新打开的问题。
- 修复 Codex 完成上下文压缩后，Handmux 仍把后续回复当作压缩器内部输出丢弃、导致对话只能在回复结束后整段刷新的问题。
- 修复 Pi 工具仍在运行时遇到历史推进，页面重连会丢失工具开始事件并导致对话流报错或空白的问题。
- 修复 Codex 同一授权请求内容更新时 Interaction 实时流被误判为非法并断开的情况。
- Agent Runtime 的 Bridge transport 启动失败不再留下不可重试的半启动状态，并会明确报告 unavailable。

## [0.25.1] - 2026-09-02

### Fixed

- 修复 Codex 自动生成标题或回顾摘要的临时线程被误认成 pane 主会话，导致对话页无法读取、收件箱批量出现无法完成的幽灵“进行中”的问题；实时绑定与服务重连现在都忽略 `ephemeral` thread，恢复正确 root thread 后会自动撤销旧假状态。

## [0.25.0] - 2026-09-01

### Added

- iOS 风格居中用量弹窗新增“订阅 / API”分栏，统一使用紧凑的 inset-grouped 列表；Claude Code 与 Codex 固定呈现标题和同构加载骨架，可分别收起内容或从始终可用的菜单单独刷新；API 页以名称、主余额和 44px 操作列展示多个 DeepSeek 与 Moonshot (Kimi) 账户，刷新状态固定在更新时间槽，并通过底部系统动作行添加账户、居中表单独立改名或替换凭证。API Key 在 Handmux 电脑的本机信任边界内使用 AES-256-GCM 静态加密，完整 Key 永不返回浏览器，添加与替换仅允许 HTTPS 或 localhost。
- Codex 用量卡新增当前账号与套餐、主账号额度、默认收起且可按需展开的特定模型独立额度，以及剩余重置次数和官方提供的各次到期时间；官方接口未提供的字段保持隐藏，不显示推测值。
- 新增统一 Agent CLI：`handmux pi [args...]` 启动原生 Pi 并原样透传参数，`handmux agent enable|status|disable pi` 显式管理 Pi 接入；Codex 接入已内置，Claude Code 使用同一管理命名空间，旧 `handmux hooks install|uninstall` 暂作兼容别名。Pi 保留原生 TUI，并通过公共对话页面获得收件箱、持久消息与实时工具状态、Markdown、排队编辑/删除、运行中追加与停止；Server 离线时结果会留在本机等待重放。Pi 对话需在设置中独立开启，当前仍标记为实验性。
- Claude Code、Codex 与 Pi 统一接入 capability 驱动的 Agent Runtime：多 pane 状态、精确 run/session、完成与出错通知、跨设备已读状态和多客户端实时流由同一套持久 Core 提供。
- 通用 Agent 对话附件通过会话绑定的 opaque resource ID 按需下载；本机路径不会发送到手机，HTML、SVG 等潜在主动内容不会在页面内直接渲染。
- Codex 会话状态详情新增当前 thread `cwd` 所属的 Git worktree 根路径与分支。
- 文件上传默认支持 ZIP 压缩包；聊天附件、文件浏览器和服务端校验使用同一扩展名规则。

### Changed

- 设置页现在统一管理 Claude Code 和 Pi 接入，可直接启用或修复，并保留用户启动 Handmux 时的 `PATH`，避免后台服务误报 Agent 未安装。
- Agent 对话收敛为唯一 capability-driven 页面：Conversation、Interaction、Queue/Goal/Plan、Context、Permission、模型控制和原生会话接管按独立能力组合；设置页将全部 Conversation Agent 合并在“对话”组，实验性能力仅在对应行轻量标记；新增 Agent 不再需要复制页面或在公共 UI 中按 Agent 分支，stable/experimental 仍由 Catalog 元数据决定。
- Conversation Queue 收归公共 Core：所有可发送 Agent 默认获得排队、查看、编辑、删除和自动发送；只有“立刻引导”取决于 Adapter 是否实现 `dispatchSteer`。
- HandMux 的最低 Node.js 版本提高到 `22.16.0`；稳定启动器会在加载产品代码前拦截低版本环境并给出明确升级提示，Homebrew 继续自动管理所需 Node。
- 等待 Agent 回复时只显示三点波浪动画，不再绘制空的气泡背景；等待行与工具调用行等高，避免内容切换时回收跳动。
- 对话自然到达顶部时才加载更早消息；历史使用 1000 条有界滑动窗口持续向前分页，慢请求显示 iOS 风格活动指示器，现有内容始终保持可读。

### Fixed

- 修复模型控制中 Fast 服务等级不再显示闪电，以及超长模型名挤掉输入区加号和操作按钮的问题；Fast 图标已恢复，模型名会优先省略。
- 修复对话页把后台会话控制轮询失败和读取超时直接显示成“暂时不可用”横幅或大块原始错误的问题；自动重试现在继续使用统一加载页或小型重连标识。
- 修复服务重启或重连后，已发送消息仍作为临时消息重复堆在对话底部的问题；切回应用不再重载已有对话，加载时也会保留底部输入区。
- 修复公共对话发送在本地回执与正式记录交接时短暂消失、重复显示或残留“已发送”，忙碌消息先闪入正文再进入队列，排队回执到达后仍无法立即编辑或删除，以及关闭功能框或使用快捷发送后手机键盘意外弹出的问题。
- 修复消息发送期间异步附件或语音结果可能覆盖下一份草稿，以及页面临时卸载后明确发送失败时原文无法恢复的问题；录音与语音最终化期间所有发送入口统一禁用。
- 修复排队消息编辑框过矮、长内容无法自然展开，以及页面后台停留后编辑凭据过期的问题；编辑框现在随内容增长并在上限内滚动，打开期间会稳定续租或透明重新取得凭据，真实并发冲突会保留草稿并明确提示。
- 修复只读或部分实现的排队控制仍显示不可用操作，以及操作完成后短暂保留旧状态的问题；按钮现在只按真实能力显示，操作成功后立即刷新。
- 修复 Codex 对话首次打开或服务重启后上下文用量圆环为空的问题；实时数据尚未到达时会从当前 thread 的持久记录恢复，用量未知时保留中性圆环且不伪装为 0%。
- 修复 Codex 长会话重连后消息队列可能永久卡住、“立刻引导”一直被拒绝的问题；现在会完整分页确认投递状态，并继续避免消息重复执行。
- 修复超大会话在 Codex App Server 恢复时一次加载完整回合历史、导致 Metis 等长期会话无法打开对话视图的问题；控制状态改为固定读取最近回合摘要，完整正文仍由分页历史提供。
- 修复从收件箱打开“已完成”对话时直接落在长回复底部的问题；现在会刷新权威最新尾部并定位到最后一条已完成 AI 文本消息开头，忽略思考、计划、目标和工具，并在定位后保持阅读位置。
- 修复 Codex 回合完成时，较早的过程说明可能覆盖最终回复、导致收件箱“已完成”摘要展示过期内容的问题；摘要现在优先使用完成事件携带的权威最终 AI 文本，仅在该文本缺失时沿用已有回退。
- 修复单个 Agent pane 的进程校验失败或 run 被外部撤销后，整个收件箱长期停滞为空的问题；异常 pane 现在会独立重试，健康任务继续恢复，收件箱完全不可用或没有任何可用状态时显示统一重连提示而不再伪装成空。
- 修复较长的上下文压缩摘要导致整个对话页显示“invalid item”、无法打开的问题；完整合法摘要仍可在压缩详情中查看。
- 修复已发送的 Codex 消息在切换 pane、响应丢失或页面加载竞态后仍残留临时气泡、与正式消息重复显示，以及新会话首条消息因空 rollout 被误判为不可用的问题；切换会话时首屏保持纯加载态，不再闪现历史内容或任何临时发送反馈。
- 修复终端和对话把普通句子中的句点误识别为文件链接的问题；裸文件名只识别常见文件后缀，带明确路径的文件仍支持任意扩展名。
- 修复服务重启后把 Codex 会话已读的历史完成事件重新当成“刚刚完成”未读消息的问题；跨 `runId` 恢复现在继承原完成时间和已读状态，不再重复推送。
- 修复当前目录没有 Git 仓库时，绑定仓库的目录选择弹窗无法关闭、反复触发“再按一次返回退出系统”的问题。
- 修复上下文压缩摘要直接铺满对话正文、压缩标识无法查看详情的问题；主对话现在只保留可点击条幅，半屏按需展示 Agent 实际保留的摘要，并保留每次真实压缩边界。
- 修复终端或对话中的 Markdown 文件链接偶发闪退、中文路径乱码且再次打开报错的问题；确认层现在会先完成返回栈退出，再稳定打开文件或目录选择器。
- 修复托管 Codex 消息发送失败后原文从界面消失的问题；失败或送达状态未知的消息现在会留在原位置，并可用同一请求安全重试。
- 统一桌面对话键盘行为：页面上按 `Shift+Enter` 聚焦输入框，输入框内 `Shift+Enter` 换行、`Enter` 发送，`Esc` 只取消聚焦；停止仅由按钮触发。
- 修复桌面端对话内容被手机长按复制样式误伤、无法用鼠标选择并复制文本的问题。
- 修复连接状态文字挤占聊天框底部按钮空间的问题；输入区不再展示连接状态，真实重连提示仍保留在对话内容区。
- 修复托管 Codex 对话把以 `/` 开头的绝对目录误判为斜杠命令、导致路径无法直接发送的问题。
- 修复部分对话首次打开、后台返回、加载更早历史或切换会话时偶发空白、无法恢复，以及新消息未发送或发送状态、草稿被旧请求干扰的问题。
- 修复 Codex App Server 短暂断连或任一 Agent 状态文本过长时整批收件箱消失，以及遗漏回合完成事件后空闲会话仍把消息永久排队、“立刻引导”无法发送的问题。
- 修复终端聊天模式整段文字与 Enter 仅靠固定延时分隔、偶尔被 TUI 识别为换行而未提交的问题；输入改用终端 bracketed-paste 边界，并按 pane 串行完整提交。
- 修复 Codex 官方额度读取较慢时错误回退到模型专属额度、导致主 Codex 用量经常显示为 0% 的问题。
- 修复 macOS 自带 Bash 3.2 在部署未创建临时依赖链接时，于退出清理阶段报 `TEMP_DEP_LINKS[@]: unbound variable` 的问题。
- 重写对话滚动与历史分页：用户开始上拉后实时内容和迟到回执不再抢回底部，轻微拖动不会立即显示“回到底部”；持续输出也不会删掉已加载历史或把视口推到页首，上一页插入时锁定原可见内容，长会话不再因客户端条目上限提前停止加载。
- 修复任务仍在运行工具或继续回复时，AI 时间提前显示在当前文字左下角的问题；时间只在整个回合结束后显示。
- 修复 Agent 能力探测或 App Server 短暂失败时，对话视图会自动跳到终端再跳回来，以及 Claude 斜杠命令会强制切换终端的问题；当前视图现在只由用户选择。
- 修复对话历史已经显示后，连接错误仍用无操作出口的遮罩挡住输入框的问题；错误改为消息末尾提示，输入和发送始终可用，发送失败单独显示原因。
- 修复进入 Codex 对话或持续输出时重复读取、投影和哈希整份大 rollout，导致手机加载超时或页面崩溃的问题；历史改为单一 Conversation 数据链、增量解析和有界缓存，实时 delta 合并到渲染帧。
- 修复托管 Codex 运行工具子进程时偶尔被误判为已退出、导致对话镜头频繁消失又恢复的问题。
- 修复无输出的 Codex 工具调用会让整个对话历史校验失败、对话视图显示错误的问题。
- 修复超长 Codex 回合让对话视图反复下载数 MB 状态、在手机上加载超时的问题；回合内容继续由分页历史和实时流提供。
- 修复存在 Codex 窗格时页面加载经常被全系统进程扫描拖慢的问题；Agent 身份仍在首次响应中严格校验，并在定向查询不可用时自动回退。
- 修复电脑或 tmux 重启后，手机仍持有旧 session/window/pane ID、终端永久停在“连接中”的问题；页面现在会按同名会话重新获取完整拓扑，单独关闭 pane 时自动切换到同 window 的有效 pane。
- 修复 npm 升级替换 Agent 可执行文件的短暂窗口与开机工作区恢复并发时，恢复的 Codex pane 可能误报未安装并退出的问题；同一次恢复现在会等待 Agent 安装完成，且不会阻塞其他已就绪的 Agent。

## [0.24.0] - 2026-08-11

### Added

- 终端与对话现可预览任意扩展名的文本文件；打开前按内容识别文本，二进制文件仍保持不可预览。
- Codex 对话新增只读回合任务列表：执行中固定在快捷输入上方，仅当前运行步骤显示动态圆环，点按可用 Bottom Sheet 查看完整计划；停止或结束后动画随即停止，并在最终回复下保留可恢复的任务摘要。
- Codex 对话新增原生 Goal 生命周期：设置或重新开始会创建全新的 active Goal，立即显示用户侧卡片并启动 Codex 自动续跑；进行中或暂停的 Goal 常驻在任务列表下方，终态反馈留在对应回合，所有入口共用同一个 Bottom Sheet，支持编辑后重新开始、暂停、继续与清除。

### Changed

- 手机命令模式键盘将 Alt 移到原波浪号位置，并在原 Alt 位置提供直接空格键。
- Server、Web 与 CLI 产品源码完成严格 TypeScript 迁移；发布包只运行编译后的 JavaScript，CI 新增源码类型、Web 生产构建和真实 `npm pack` 安装启动门禁。
- Web 弹层统一由单一 Overlay Host、显式返回栈和语义层级管理；浏览器 Back 与 Escape 每次只关闭视觉顶层，半屏详情、确认层和全屏工具共享软键盘位置与焦点所有权。
- Codex 待发队列、幂等回执和有序会话 Journal 改为私密原子持久化；Handmux 重启或不确定投递后会先与 App Server 对账，实时事件与 rollout 历史由 Server 统一投影并支持按游标补拉。
- API 未处理异常现在统一返回带错误码和 Request ID 的 JSON，不再向客户端暴露本机路径、源码位置或异常堆栈。

### Fixed

- 进一步修复主屏 App 切到其他应用再返回后，进行中的终端或 Codex 对话可能停在旧画面、必须切换内部视图才能恢复的问题。
- 对话与终端使用同一套严格的文件识别规则；普通的“开始/暂停”等斜杠文字和未识别的 Markdown 目标不再高亮或允许点击。
- 修复用户发送消息后，实时回复偶尔显示在用户消息上方、直到切换页面才恢复的问题；临时消息现在始终位于对应回合回复之前。
- 修复 Goal 与其他工具在同一批次结束时，“目标已阻塞”等终态卡片可能在服务重启后消失的问题；恢复后的目标正文继续按最多三行展示。
- `~/.handmux` 中的鉴权状态、CLI 配置、Push、预览、通知、更新缓存、Hook 与 Usage 快照统一使用私有权限和原子替换，并在读取旧文件时修复历史宽松权限；自定义配置路径不会修改不属于 Handmux 的共享父目录。
- Supervisor 启动参数和系统自启动文件不再包含 Token、VAPID 私钥或语音密钥；完整配置改从 `0600` 私有文件读取。
- Supervisor 现在分别维护 Server 与 Tunnel 的进程阶段和重启退避；Server 退出会立即撤销就绪状态和 PID，不再让一个子进程的连续失败拖慢另一个子进程，并改为校验 `/health/ready` 的 Workspace、Codex 与 Browser Worker 状态，而不是仅检查 TCP 端口。

## [0.23.0] - 2026-08-09

### Added

- 新增 Codex 托管对话视图：终端与手机保持同一会话，可实时查看 Markdown 回复、完整工具调用、提问与审批，并直接停止任务；断线或重新打开后仍能恢复完整对话。
- 新会话可用 `handmux codex` 直接启动托管模式；普通 Codex 窗格也可从对话页原位接管并恢复准确会话，需要终端确认时会提示用户切换处理。
- Codex 回复期间可继续发送消息：消息默认排队到下一回合并依次处理，也可逐条编辑、删除或立即引导当前回复。
- Codex 输入区新增模型、思考强度与 Fast 设置，以及上下文占用和会话状态入口；支持直接调整权限，并原生处理 `/goal`、`/compact` 和 `/clear`。
- 对话中的文件路径与 HTTP(S) 网址可复用终端的确认和打开流程，直接进入文件预览或网页预览器。

### Changed

- 终端与对话的切换按钮改为显示点按后将进入的视图。
- Claude Code 与 Codex CLI 的对话视图改为独立开关；仅 Claude Code 保留实验性标识。
- Codex 的对话、收件箱状态和通知统一使用托管模式；Hooks 仅继续服务 Claude Code，升级时会清理 Handmux 旧版写入的 Codex Hook 配置。

### Fixed

- 修复应用长时间停留在后台后，返回时对话和页面状态可能一直停在旧画面的问题。
- 多窗格窗口的窗格面板改为立即打开并在后台刷新，不再因网络较慢而阻塞点击。
- 修复手机终端聚焦输入框时可能被软键盘重复顶到屏幕顶部，以及 iPhone 收起键盘后终端可显示区域可能无法恢复整屏的问题。

## [0.22.1] - 2026-08-04

### Changed
- 网页预览器将容易误解的手机 / 电脑视图拆分为窄屏 / 宽屏页面宽度；电脑代理标签可另外向网站请求手机版或电脑版，切换时保留该标签的登录状态。

### Fixed
- 修复电脑代理临时重启后，重新打开网页预览器或切回代理标签时可能停在 `browser unavailable` 错误页、需要反复刷新的问题。
- 修复代理会话过期、丢失或设备 Cookie 失效后，网页可能停在 `browser session unavailable` 错误页而不会自动恢复的问题。

## [0.22.0] - 2026-08-03

### Changed
- 将列宽调整从设置页移到对应的窗口管理或分屏管理中；纯上下分屏不再显示无效的宽度控制，恢复分屏比例也不会改变整个窗口尺寸。
- 设置改为全屏分组页面：语言、字体、键盘、终端传输和对话配色使用统一的二级页面，版本、更新日志和重新加载应用集中在首层；从二级页返回时保留首层位置。
- 通知设置按「推送通知、脚本推送、脚本推送记录」排列，关闭推送通知前会先确认；同一 App 安装中关闭再开启推送会保持原设备 key，定向推送脚本无需修改；每次重新打开设置都会从顶部开始。

### Fixed
- 修复 App 冷启动时实时终端可能先降级为快照、切换窗口后才恢复实时的问题。
- 修复重启后从最近访问打开已有静态目录时重复新增标签的问题；同一目录现在直接激活原标签，并自动合并已有重复项。

## [0.21.0] - 2026-08-03

### Added
- 新增顶部常驻的网页预览器：可由手机直连开发服务、`localhost`、内网和允许嵌入的网站，也可在通过 `handmux setup` 配置 `previewDomain` 后选择经电脑代理访问；原静态目录预览也融合到同一界面。
- 电脑代理新增按设备隔离的 Cookie Profile：相关企业系统可复用符合真实域规则的 SSO Cookie，并可选择加密持久化到电脑、按网站清理或全部清理；不同设备与手机直连始终隔离。

### Changed
- 运行 handmux 的最低 Node.js 版本由 18 提升至 20；网页电脑代理使用的底层依赖要求 Node.js 20。
- 原动态端口预览升级为网页预览器；网址和静态目录使用统一的设备本地标签与最近访问，支持按创建顺序排列、后台自动关闭，并在切换标签时保留页面、滚动和表单状态。
- 手机直连、电脑代理和静态目录共用手机 / 电脑视图、75%–200% 网页缩放、刷新与停止；缩放只作用于网页内容，放大后保持原布局并显示滚动区域，标题栏和工具栏保持固定。
- 静态目录由手动 TTL 改为访问自动续期，关闭标签立即释放，异常遗留两小时后回收；不再提供 `--preview-ttl` / `HANDMUX_PREVIEW_TTL`。静态预览使用独立运行 token 与 opaque iframe，不再在预览 URL 中携带主 Handmux token。
- 网页预览器明确说明它不是真正的完整浏览器，并提供“用系统浏览器打开”：手机直连受目标站 iframe / CSP、第三方 Cookie 和手机网络限制；电脑代理会转发并改写页面，也不保证兼容所有网站。

## [0.20.3] - 2026-08-01

### Changed
- 降低实时推送在持续输出、多窗口和长时间浏览历史时的资源占用。

### Fixed
- 修复实时推送在内容较短或终端较高时未贴近底部，以及首次打开、键盘展开或收起时画面闪动的问题。
- 修复实时推送连续输出时，历史与实时区域之间暂时缺少中间内容、输出结束后才恢复的问题。

## [0.20.2] - 2026-07-27

### Fixed
- 修复实时终端长时间打开、瞬间输出大量内容或电脑同时显示多个 PWA 时，终端渲染导致整个页面卡顿的问题。

## [0.20.1] - 2026-07-26

### Fixed
- 电脑端停留在终端页面时，即使焦点落在 Window 工具栏，物理键盘输入和 `Shift+Enter` 仍会作用于当前终端；`F5`、`F12` 保留给浏览器。
- 修复聊天模式选择文件后没有开始上传的问题。
- 聊天发送过程中会暂时锁定输入和发送键，避免快速连按重复发送同一条内容。

## [0.20.0] - 2026-07-26

### Added
- 手机和电脑的终端新增 WebSocket 实时推送；首次打开即可上滑浏览最近的 tmux 历史，继续向上时沿用现有历史加载，回到底部后重新同步。离开页面超过 10 秒后会丢弃旧输出并从最新画面继续；实时推送连接失败时自动退回快照拉取，点击右上角状态可查看延迟、降级原因和恢复倒计时，也可在设置中让当前浏览器固定使用快照拉取。
- 设置中新增「重新加载应用」，服务端更新完成后可直接载入新版客户端，无需退出主屏应用再重新打开。

### Fixed
- 未开启设备通知时不再因等待 Service Worker / 设备 key 而误报「通知记录加载失败」；真实超时和 HTTP 错误会保留具体阶段。
- 设置中的更新日志、通知记录、预览、目录选择器和菜单会保留设置父层；返回或电脑端 `Esc` 每次只关闭最上层，连续操作可逐层回到主屏。
- Window 选中和未选中状态下，高度以及 Agent 图标与窗口名称的间距保持一致。

## [0.19.0] - 2026-07-25

### Added
- 电脑浏览器现在可用物理键盘直接操作终端；按 Shift+Enter 或点击草稿框进入草稿模式，Enter 发送后继续编辑，Shift+Enter 换行，Esc 或点击终端回到直通模式；鼠标可原生拖选文字，Mac 用 Cmd+C / Cmd+V、Windows / Linux 用 Ctrl+Shift+C / Ctrl+V（或 Ctrl+Shift+V）复制粘贴；设置中可为当前浏览器自动识别或手动指定手机 / 电脑键盘模式。

### Changed
- 内容区域、终端、代码和 Diff 现在使用统一的细滚动条；终端内容超出宽度时，电脑和手机会显示独立横向滚动条。
- 网络较慢时，切换 Window 会立即进入目标终端的加载页面，不再等待窗格列表返回后才响应。

### Fixed
- Agent 用量现在稳定展示所有设备共享的本机最新状态，Codex 主额度与 CLI `/status` 保持一致。

## [0.18.0] - 2026-07-22

### Added
- 新增 Tmux 工作区恢复：电脑或 Tmux 重启后，可从手机或 `handmux restore` 恢复上次的 session、window、pane、工作目录和布局，Claude Code / Codex 会话可以继续原对话。
- 新增 `handmux shortcuts`，可分别配置命令 / 聊天模式的共享快捷项；每台手机也能自由混排共享与本机项，或只在本机移除共享项。
- 动态预览现在可在 `handmux setup` 中配置域名；打开后不再自动续期，需要延长时可手动点「续期」或重新打开本机链接。

## [0.17.8] - 2026-07-20

### Changed
- 分屏地图会在空间足够的窗格里低调显示真实终端尺寸（列×行），拥挤的小窗格仍只保留主要信息。

### Fixed
- iPhone 上的分屏地图浮层不再被窗口栏的横向滚动容器裁掉而无法显示。
- iPhone 上长按分屏地图里的窗格时，不再同时触发系统文字选中与复制浮层。
- 设置分屏窗格列宽时会先读取当前窗格的实际宽度，不再沿用同一窗口里上一格的调整值。

## [0.17.7] - 2026-07-20

### Changed
- `handmux status` 现在显示实际运行版本；升级后尚未重启时，也会同时提示已安装的新版本。

### Fixed
- 安装开机自启后，`start` / `stop` / `restart` 统一交由 launchd/systemd 管理，不再因服务管理器自动拉起旧 supervisor 而产生双实例、端口占用、`restart` 不出 URL 或 `stop` 后仍可访问；生命周期锁会阻止并发启动，进程表兜底会提示未登记/重复 PID，`stop` / `restart` 则回收全部副本并确认归零；重启还会刷新升级后的可执行路径与固化配置。
- `handmux status` 完成输出后会显式退出，避免 WSL 中公网探活留下的 Node 网络句柄让终端迟迟不返回命令行。

## [0.17.6] - 2026-07-20

### Changed
- 对话视图的权限确认卡改为左侧取消、右侧确认；取消需在 2 秒内再点一次才会执行，避免误触中断当前请求。

### Fixed
- 长对话转录轮询改为只切取手机实际请求的分页，不再每轮遍历和复制整段会话，降低超长会话对服务端 CPU 和内存的瞬时压力。
- 关闭通知现在会立即关闭本地开关，后台完成有限时的订阅清理；通知收件箱、删除、设备 key、测试推送与后台状态同步也不再因浏览器或网络无响应而无限等待。
- 对话视图向上加载历史改为每页 20 条；首次打开时如果内容不足一屏，即使镜头的高度稍后才稳定，也会继续自动补取更早消息。
- `handmux push` 只在至少一台设备送达且没有任何失败时返回成功；零送达和部分失败现在会输出 `sent/failed/gone` 完整计数并以非零状态退出。
- 每台设备的脚本通知收件箱现在单独记录该设备的发送结果：列表显示成功/失败，详情会标明订阅失效、限流、推送服务不可用、拒绝或网络错误；不再用整次命令的“部分”状态混淆单台设备。

## [0.17.5] - 2026-07-20

### Fixed
- 开启设备通知会在操作点主动注册通知服务，不再依赖启动阶段被静默忽略的尽力注册；各阶段现在分别超时并提示具体处理方式，欢迎推送被拒绝时也不会再假报成功，失效订阅会自动重置后引导重试。
- 通知记录加载失败时不再误显示为空，删除失败时也不会让消息先消失再重新出现；现在会保留已有内容并提示重试。
- 设置里的完整更新历史恢复为逐版本展示；有新版本时的升级提示默认只展示最新一条，其余版本可按需展开。
- 对话视图改为异步增量读取会话记录并限制服务端 session 缓存与手机端常驻消息数，避免长会话轮询反复全量解析、阻塞服务或持续占用手机内存。
- Agent 存活识别现在绑定前台 PID 与真实 executable：Claude 探测失败会短期重试，Codex 退出后启动普通 Node 程序也不会让旧状态重新出现。
- 动态预览认证改用当前子域专属 Cookie，兼容两段式域名且不再向父域/兄弟子域扩散凭据；本机预览启动失败会显示真实原因。

## [0.17.4] - 2026-07-19

### Fixed
- 对话视图在 Codex pane 上不再误读同目录的 Claude 会话；在 Codex 适配完整落地前，前后端均按 Claude-only 关闭入口。
- `handmux push --url` 现在只接受 HTTP(S) 或安全的站内相对链接，并拦截历史通知中的危险协议链接。
- 本机地址一键预览现在完整支持 HTTPS/WSS 上游（含常见的 loopback 自签名开发证书），并修复带 `#fragment` 的深链因 token 落在片段后而 401。

## [0.17.3] - 2026-07-19

### Changed
- 应用内「更新日志」改为只展示最新一个版本（同日连发补丁时不再刷屏）。

### Fixed
- 修复了 0.17.2 对官方一键安装器版 Claude Code 的识别在真实环境仍未生效的问题：ps 报的进程名（claude 自设标题）与 tmux 报的（版本号）根本不一致，按 ps 名对账永远失败。改为用 lsof 真实路径的**文件名**与 tmux 版本号对账 + 路径含 `claude`——已由真机数据验证（`ps` 报 `claude`、`lsof` 报 `…/claude/versions/2.1.196`）。

## [0.17.2] - 2026-07-19

### Fixed
- 修复了 0.17.1 对官方一键安装器（native installer）版 Claude Code 的识别在 macOS 上仍未生效的问题：上一版假设 `ps` 能给出进程全路径（实际只有 basename），佐证从未通过。现改为用 `lsof`（Linux 为 /proc）取进程真实可执行路径，路径中含 `claude` 即认——覆盖所有官方安装布局，与版本号、安装方式无关；路径不含 `claude` 的同名软件不会误认。

## [0.17.1] - 2026-07-18

### Fixed
- 修复了在用官方 native installer 安装 Claude Code 的机器上认不出 Claude 会话的问题（该安装方式的进程名是版本号而非 `claude`，导致没有 agent 图标、对话视图切换钮不出现）。识别改为 ps 路径佐证：进程名疑似版本号时，只有其真实路径位于官方 `~/.local/share/claude/versions/` 目录才认作 Claude——不会把其他恰好以版本号命名的软件误认成 Claude。

## [0.17.0] - 2026-07-18

### Added
- **对话视图（实验性功能，默认关闭，可能不稳定）**：把 Claude 会话从「终端画面」切换成「聊天记录」来读、来操作——设置里打开「启用对话视图（实验性功能）」后，窗口栏出现切换钮，同一 pane 在 终端 / 对话 两个视图间一键互换（终端视图仍是默认，完全不受影响）。**未安装 Claude hooks 时开关锁定**（对话的问题卡/状态提示依赖 hooks，没有它视图会把「等你回答」伪装成「空闲」），设置里附一键安装；未检测到 Claude Code 时同样锁定。气泡式对话（Markdown 渲染、代码块，思考过程不占屏），滑到顶部加载更早消息；工具活动**如实**成卡——该运行命令就显示命令、该调工具/激活技能/调 Agent 就分别显示，一句话摘要 + 点按开底 sheet 看完整命令与输出，编辑文件的卡带 **+A/−B 增删行数**与逐 hunk **彩色 diff 明细**（取自转录里的 `toolUseResult.structuredPatch`），详情弹窗可用系统返回键关闭；Claude 提问/要授权时底部弹**问题卡**——真实选项点按即答（单选、多题向导、计划批准），卡片上方附问题正文最后一行，遮罩只盖住视图区域；专属输入卡（语音输入、快捷回复、斜杠命令发送即回显 pill）；上下文压缩全程可见（压缩中动画 → 「上下文已压缩」分隔线 + 压缩摘要），并显示当前上下文占用百分比；三套**暖色配色**（暖夜 / 暖金 / 暖黄，设置里选）；加载中与新会话都有友好占位（「正在加载」波浪 / 「发送你的第一条消息」）。数据全部读自 Claude 会话转录文件（jsonl）+ 抓屏，不动 PC 端任何状态。
- Claude Code hooks 新增 **SessionStart** 事件（/clear 换新会话后手机端立即重新绑定），并在服务启动时**自动补齐**已安装用户缺失的 hook 事件与脚本更新——升级即生效，无需重装 hooks；同时接入 2.1.207+ 的 PreCompact/PostCompact/StopFailure（旧版本自动跳过）。
- 通知收件箱：脚本推送（`handmux push`）的通知会按设备存到服务端（每台手机一个文件 `~/.handmux/notifications/<设备>.json`，各保留最近 100 条），进入一个全屏「通知记录」页翻看历史、逐条点开看详情（带 `--url` 的会在详情里给「打开链接」）、逐条删除；点手机通知直接深链到那条消息的详情页。收件箱按推送范围隔离——`--device`/`--session` 定向的通知只进目标设备的收件箱。有未读时设置齿轮亮红点，点开某条即标该条已读。只记手动脚本推送，不含自动的会话状态提醒。
- 终端里打印出的本机地址（`http://localhost:3000/...`、`127.0.0.1`、`0.0.0.0`、`[::1]`，带端口和路径）现在会自动识别、加下划线可点：点一下弹出小气泡「开启代理并预览」，确认后自动把该端口通过动态预览反向代理起来，并直接把 `http://localhost:3000/foo/bar` 里的 `/foo/bar` 路径打开在手机的预览浮层里（手机访问不到电脑的 localhost，代理替你转发）。同一窗口不同端口的地址各自独立起代理、可**并行查看**：预览浮层顶部多出一条可横滑的标签条，每个打开的预览（含从设置里起的窗口预览）一个标签，点标签即时切换、每个标签的页面各自挂着不重载（HMR/滚动/表单状态不丢），标签上的 `×` 直接停掉该预览。预览浮层开着时会给所有打开的预览自动续期（到期前约 1 分钟自动刷新 TTL），正在看的不会中途过期；收起或关掉后照常按 TTL 回收。没配预览域名（动态预览未开启）时，气泡会提示去设置里配置，而不是静默失败；端口没有服务在监听时也会就地说明原因。程序若把本机地址以 OSC 8 超链接（`ESC ]8;;URL`）而非纯文本形式打印（xterm 原生会把它变成可点链接、点击直接用浏览器打开），也会被拦下改走我们的代理预览：给 xterm 配了 `linkHandler`，回环 URL 一律路由到预览流程，其余链接照常在新标签打开。新增前端 `web/src/localUrl.js`（回环 URL 识别，纯函数、含单测）；识别与文档路径检测按字符区间互斥，避免 `localhost:3000/foo.html` 被误当成文档路径。

### Fixed
- 对话视图：发送 /compact 当时无任何显示（命令脚手架要等压缩完成才落盘），现在发送即回显命令 pill，压缩完成后自动替换为真实标记与结果。
- 对话视图：问题卡的遮罩把顶部标签栏与功能键也盖住了（现在只遮视图所在的下半区）；过短的确认卡盖不住输入区的快捷键。
- 对话视图：转录曾按「同目录最新会话」绑定，多个同目录会话并存时会串到别的会话，现在绑定到 pane 自己的会话（hook 上报 transcript_path）。
- 点开手动脚本推送的通知不再多开一层空白页，而是直达该条消息的详情。

## [0.16.0] - 2026-07-15

### Changed
- 绑定会话弹窗把「新建 / 已有会话」改成顶部二选一分段控件：原先「＋ 新建会话」和各个已有会话名并排在一排实心药丸里，看起来像点一下就直接建会话；现在「新建 | 已有会话」是清楚的模式二选一，选「新建」只露出创建表单、选「已有会话」才露出会话列表，真正的动作仍是底部按钮。有可绑定的会话时默认落在「已有会话」。

### Fixed
- 键盘开着时左右横滑切换命令/聊天页不再偶尔把键盘收掉：起手判断「键盘是否开着」原先只看焦点在不在输入框上，
  而系统有时会在焦点已漂离输入框时仍留着键盘，于是横滑被当成「键盘没开」而收掉（之前要先竖划一下重新聚焦才能
  规避）。现在改用键盘的真实高度判定，横滑始终把焦点带到目标页的输入框、键盘保持不动。
- 反复来回切换窗口时，键盘不再偶尔自己弹出来还收不掉：v0.15.0 加的「光标预热」在每次切窗重挂终端时会 focus
  一下 xterm 的隐藏输入框来激活光标渲染，但把这个输入框设成「不唤起键盘」（`inputmode=none`/`readOnly`）的代码
  排在预热之后才执行——于是预热聚焦的是一个还能唤键盘的真输入框，安卓上偶尔会和切窗手势的用户激活撞上、把软键盘
  弹出来且卡住。现在改为先把隐藏输入框设成键盘惰性、再预热，光标照常激活，聚焦永远不会唤起键盘。

### Added
- 分屏地图现在能建/删窗格：长按地图里的某块瓦片弹出该窗格的操作菜单——「左右分屏」「上下分屏」（只这两种方向，对标 tmux `split-window -h`/`-v`，新窗格继承该窗格的当前目录、用 `-d` 不抢电脑端焦点），以及「关闭此格」（两步确认）；单窗格窗口没有地图，改在长按窗口标签的管理菜单顶部提供「左右/上下分屏」。分屏后手机视图自动切到新建的那格；关掉正在看的那格会自动跳到存活的相邻窗格；切换、分屏、删除后地图都保持打开并实时刷新到最新布局、把高亮落到当前正在看的那格，点空白处才收。分屏方向配了和整体一致的描边图标（左右=竖分隔框、上下=横分隔框）。长按任意单格窗口（不必是当前窗口）都能从菜单直接分屏，分完自动切到那个窗口的新格；长按一个已经分屏的窗口，菜单里多了「管理分屏」：直接打开分屏地图并同时弹出操作面板（落在当前正在看的那格，可点别的格切换目标）。新增后端 `POST /panes/split` 与 `DELETE /panes`（拒绝删掉窗口里最后一格，避免误连窗口/会话一起关掉）。
- 多窗格选择器改为按真实 tmux 分屏布局排列的比例地图：原先只是把当前窗口的窗格拉成一个扁平下拉列表，看不出谁在屏幕的哪个位置；现在按每个窗格的真实行列坐标（`list-panes` 新增 `pane_left`/`pane_top`）等比例画成一张分屏缩略图，每格是一块可点的窗口瓦片（留缝、圆角、序号徽标 + 命令名 + Agent 图标），点某格即切换到查看该窗格（切换行为不变，仍是纯客户端重定向、不动 PC）。地图用原生 iOS 毛玻璃浮层、当前窗格 iOS 蓝实心高亮；细长/矮扁的窗格按瓦片实际尺寸自动降级内容（窄的只留居中序号、扁的把序号和命令排一行），不改比例仍认得出、点得到；浮层锚定后再对视窗边界做钳制，靠边也整块留在屏内；tmux 版本过老取不到坐标时自动回落原扁平列表。

## [0.15.0] - 2026-07-14

### Added
- 键盘弹起时终端不再把顶部内容顶出屏外：网格按键盘上方的真实高度重排，主屏短内容贴键盘上沿显示；全屏应用（vim/less/htop 等）可在内部上下滚动、到顶/底才翻页，默认显示程序第一行、移动光标时自动跟随、手动滚动时让位。
- 全屏应用翻页胶囊新增「适配高度」与「定位」两个键（与上下键分组）：「适配高度」按收起键盘后的真实可用高度缩放字号，把整屏程序完整放进手机屏（逐帧按最终行高校验、必要时再收一档字号，保证不裁掉行）；「定位」是开关，点亮后高亮光标所在行的背景并自动跟随，切回主屏自动清除。键盘弹起、视口滚离底部时光标改用装饰层绘制以保持可见（xterm 原生光标此时不渲染），收起键盘后仍把光标留在可视区。

### Changed
- 全屏应用手指滑动触发上下键更灵敏（每 12px 一格）。
- 预览注册表改为内存单写者模型（原先每次操作重读并回写 JSON，GET 时的过期清理可能与并发注册竞争而丢条目）；
  push 订阅与预览的持久化都改为原子写。`/states` 轮询与文件监听并发时不再交错去重状态导致重复推送。

### Fixed
- 补上收件箱在普通授权模式下一种场景漏掉的状态变更：你**回应权限弹窗后**该会话会停留在「需要你」。原因是
  这几种回应都不产生可监听的 hook——授权普通工具（Bash/Edit 等）不触发我们监听的 PostToolUse，手动拒绝或按
  ESC 中断则不发任何 hook，于是收件箱收不到「已回应」的信号。现在服务端改用会话 transcript 的写入对账：弹窗
  挂起时 Claude 阻塞、transcript 不增长；你一旦回应它就长大、修改时间越过该事件——据此判定已回应，并读
  transcript 末行区分去向：**授权（yes）或拒绝并反馈 → 恢复「进行中」**；**按 ESC 中断（末行是
  `[Request interrupted by user]`）→ 消掉状态、回落中性「在场」态**。读不到 transcript 则维持现状，绝不误判。
- 终端上滑一点后不再会自己一行一行往上爬：根因是上一版把「原地直播刷新」的滚动锚点也改成了按像素反推
  （`floor(scrollTop/行高)`），而行高是小数、浏览器把 scrollTop 存成整数，反推偶尔少一行——于是每帧重绘就掉一行
  （只在滚了一点、且是活跃刷新的 pane 上出现，空闲页不重绘所以不漂）。日常直播刷新改回用 xterm 的整数行号锚定
  （零漂移），像素反推只保留给上滑拉历史那条（fling 可能停在半行，仍需对齐渲染行以免「拉取后高一行」）。
- 光标不点屏幕也能显示了：根因是 xterm 在终端从未被聚焦前根本不渲染光标（连失焦 block 样式也不画），而我们的网格只读、从不聚焦，所以之前必须点一下（点击会聚焦终端）才看得到光标。现在终端创建时用一次 focus/blur 激活渲染器，之后光标随 tmux 状态正常显示。此外，发键/发指令后即使 Claude 正在工作（光标本被隐藏）也会点亮光标并保持到它重新空闲，操作时始终看得到光标在哪。
- 启动**动态端口预览**后现在会像静态预览一样自动弹出预览面板：此前从设置里启动动态预览，面板会一闪而过又收回（要手动点顶栏预览图标才打开）——根因是关闭设置面板时其返回键守卫会 `history.back()` 发出一个 popstate，而预览面板几乎同帧打开、监听器刚挂上就把这个「返回」当成用户按了返回而自关（静态因为在网络请求前就早早关了设置、那个 popstate 早已消散才侥幸不中招）。现在动态路径把开面板推迟到设置的返回 popstate 之后，面板监听器挂在干净的历史栈上。
- 会话重命名撞到已有名称时正确提示「名称已存在」，不再显示通用的「重命名失败」：底层网络封装此前丢掉了服务端的 409 状态码，改为结构化的 `ApiError`（保留 `status`）后，重名场景能被识别并给出准确文案。
- `handmux stop`（及 `restart`）在 supervisor 已崩溃/被强杀时不再遗留孤儿的 server/tunnel 子进程：停止时
  若发现 supervisor 已死但状态文件仍在，会先回收记录在案的子进程再清理状态（此前正是「stop 后 cloudflared
  仍在跑」的成因）。`state.json` 改为原子写（临时文件 + rename），并发读不再读到写了一半的内容而误判为「未运行」。
- `handmux update` on a Homebrew (tap) install no longer runs `npm i -g` over itself — that planted a
  second, conflicting copy Homebrew couldn't see or upgrade. It now detects the brew install and points you
  at `brew upgrade handmux`; the "upgrade available" notice shows the matching command per source.

## [0.14.0] - 2026-07-13

### Added
- 脚本推送：CLI `handmux push <title> <body>`（全部/`--session`/`--device` 三种范围）+ 内部端点 `/api/push/send-local` + 设备 key + 应用内「脚本推送」说明浮窗（含可靠性边界提示）。
- 终端选中改为 iOS 式持久选区：可拖首尾手柄精调、跨屏选择，callout 浮条（拷贝/整行/整段），复制自动去空格；选中时顶部显示蓝色「复制模式 · N 行 · M 字」状态条（字数按去空格后计）；手柄出现后滑动/滚动保留选区，单击才取消。

### Changed
- **A stray Back press on the main page no longer drops you out of the app.** The first Back now just shows
  a "press Back again to exit" hint; only a second press within ~2s actually leaves. Back still closes any
  open sheet/panel first, exactly as before — the guard only kicks in at the root.
- **Scrolling the terminal no longer drops the on-screen keyboard.** Dragging to scroll used to blur the
  input and collapse the keyboard, so you couldn't read while it stayed up. Now a *swipe* keeps it up (read
  freely while it's open); a *single tap* on the terminal puts it away (the iOS-native "tap outside to
  dismiss" habit). You can also show/hide it with the ⌨ button or the grip handle at the top of the dock —
  drag the handle (or swipe anywhere on the dock) up to reveal, down to dismiss, or tap to toggle, on both
  the command and chat pages; it follows your finger with a rubber-band resistance and lights up once you've
  dragged far enough to commit.
- **The keyboard now stays open when you switch between command and chat.** Opening it in one page used to
  leave the other page's box inactive (or drop the keyboard entirely on the way back); it's now a shared
  state — switch modes with the keyboard up and it stays up, with the newly-shown box focused and ready. A
  page-swipe that merely grazes the chat composer no longer conjures the keyboard in the other mode.

### Fixed
- **The ⌨ toggle no longer gets stuck on "hide keyboard" after the system quietly drops the keyboard.**
  An aborted app-switch gesture (and similar) can dismiss the soft keyboard *without* blurring the input,
  so the toggle kept showing "收起键盘" with no way to raise it again. The keyboard state now reconciles
  against the actual viewport, so it flips back to "展开键盘" and the next tap opens it cleanly.
- **Scrolling a long chat draft no longer randomly pops or drops the keyboard.** A multi-line draft that
  overflows the composer now scrolls on its own; the up/down keyboard gesture only takes over once you're
  at the very top or bottom of the draft (iOS nested-scroll fall-off), instead of every vertical swipe.
- **The bottom dock no longer drifts up/down under your finger with the keyboard open.** With the soft
  keyboard up the browser was natively panning the whole page to keep the focused field in view, and that
  scroll was draggable — so a drag on the keys/input slid the entire dock (grip handle and all) with your
  finger (worst on iOS, a jitter on Android). The page is now locked against that pan (real scrollers — the
  terminal, sheets, the key strip — still scroll), which also fixes the keyboard inset mis-measuring to zero
  on iOS, so the dock now sits squarely above the keyboard. Switching modes no longer momentarily jumps the
  layout either (the focus no longer drags the page).
- **A full-screen app (vim/less/htop) no longer leaks unrelated terminal history above it.** An alt-screen
  pane has no scrollback, but the server was still asking tmux for history — which returns the *main*
  screen's scrollback above the app, so scrolling up showed old terminal output that wasn't part of the
  running app. It also capped the app's trailing blank rows, mangling a fixed-height screen. Alt-screen
  panes are now captured as exactly their visible screen, so what you see is only the app.
- **The Back-to-exit guard is now reliable — no more phantom "press again to exit" hints, silent exits, or
  needing several Back presses.** Opening a session (from the drawer, an inbox row, or a notification tap)
  rewrote the URL hash in a way that wiped the state marker off the current history entry — the very marker
  the Back-button guard uses to tell the exit guard and open panels apart. That desynced the guard from the
  real history stack, so the hint could fire at the wrong time, a single Back could drop straight out, or it
  could take several Backs to leave. The hash rewrite now preserves that state, keeping the guard in sync.
- **Once the "press again to exit" hint disappears, the next Back re-prompts instead of dropping you out.**
  The hint and the exit window were two independent 2s timers that could drift apart, leaving a gap where the
  hint had vanished but a Back still exited. They're now a single timer: the hint is visible for exactly the
  exit window, so the moment it's gone the guard has re-armed.
- **Opening a session from a system notification no longer pops the "press again to exit" hint on arrival.**
  A notification tap navigates the app to the target deep link, and that navigation fired a history event the
  exit guard mistook for a root Back — so the hint appeared the instant you arrived, without touching Back.
  The guard now marks its own root entry and only arms when a Back genuinely lands back on it, ignoring
  forward navigations.
- **Tapping a notification into an already-open app no longer costs an extra Back press to leave.** The
  service worker used to `navigate()` the open tab to the deep link, which pushed a spurious history entry
  above the app — so the first Back just silently consumed it and you needed one more to exit. It now hands
  the deep link to the running app to open in place (no history push); a genuinely closed/discarded tab still
  opens fresh at the deep link as before.
- **Scrolling up through terminal history no longer stacks multiple pulls or jumps a page.** A hard flick's
  inertia used to keep re-hitting the top while a deeper slice was still loading and fire the pull again,
  stacking several pages off one flick and yanking the view around. The inertial coast is now frozen the
  instant a pull starts, so reaching the top loads exactly one clean page and holds your place; flick again to
  go further. History is pulled in whole 100-line pages, and the readout shows the real buffer state —
  `距底 N/M 行` (how far up you've scrolled / total history loaded), updated live during the coast.

## [0.13.0] - 2026-07-12

### Added
- **A “Token” row in `handmux setup` — set the access token by hand.** Previously the token was only ever
  auto-generated (a fresh one each start, so the phone URL changed on every restart). The setup hub now has
  its own top-level Token row (after Port): type a custom one, generate + pin a strong random one, or reset
  back to auto. A pinned token keeps the URL stable across restarts; the hub masks it and the edit field
  pre-fills it so you can read it off.
- **A “Highlight file paths” switch in Settings (off by default).** The soft blue wash behind tappable
  terminal paths is now opt-in — off, the terminal stays plain, but the paths remain tappable either way.
  Flipping it takes effect immediately, no reload.

### Fixed
- **The Settings sheet scrolls when it's taller than the screen.** The centered card had no height cap, so
  on a short viewport (or with many sections) the top and bottom clipped off with no way to reach them. It's
  now capped to the viewport and its body scrolls, with the title + close button pinned so they're always
  reachable.
- **Desktop mouse-wheel scrolling now loads deeper history instead of stalling at the first chunk.** On a
  desktop browser the wheel drove only xterm's native scroll, and once its scrollbar hit the top it stopped
  firing the events that pull more scrollback — so every pane got stuck about one screen + 100 lines up. The
  wheel now triggers the deeper-history pull directly (as the touch path already did), and on a full-screen
  app (alt-screen) it's forwarded to the app as scroll instead of exposing the stale main-screen buffer
  underneath. A thin, unobtrusive scrollbar is now shown on both desktop and mobile.
- **The agent icon (and the dock's default mode) now track whether the agent is actually running, not
  whether it just spoke.** Both keyed off the inbox roster, which only lists panes with a recent hook
  event — so a freshly-opened session that hadn't been prompted yet, or one right after `/clear` (whose
  `SessionEnd` drops the roster entry though Claude is still running), showed no agent icon and slid the
  bottom input from the chat composer back to the command keyboard under you. The server now also reports
  a pane whose foreground program *is* a coding agent as present (matched by process name, so a plain
  shell or bare `node` is never mistaken for one), independent of activity — the icon stays and the mode
  holds while the agent lives, and both correctly clear the moment it exits to a shell.
- **The agent logo in a split (multi-pane) window is now per-pane, not per-window.** The window bar
  squashed every pane in a window down to one agent, so exiting the agent in the pane you were on left the
  tab's logo lit by a sibling pane, and two *different* agents in one window collapsed to a single
  (arbitrary) logo. The active window's tab now shows only the current pane's agent (exit it → the logo
  clears), and the pane menu shows each pane its own logo — Claude and Codex side by side render
  distinctly, and a pane that has dropped to a shell shows none.
- **Tappable file paths in the terminal survive surrounding punctuation and line wraps.** A path clung to
  by a decorator no longer swallows it into the name: a trailing `…` (Claude Code's truncation ellipsis),
  markdown `*`/`**` around the name, a `label:path` colon with no space, and a leading `@` (a `@file`
  mention — kept when it's internal, e.g. `@types/`) are all trimmed, so the real file is found. And a
  path that Claude Code folds across two rows by width (a hard newline, not xterm's own soft wrap) is now
  stitched back into one tappable link instead of only its tail fragment; box-drawn panels stay unfused.
  A wide-character (CJK) path folded across two rows is also no longer severed — a wide glyph can't
  straddle the last column, so the fold leaves a spacer there (empty on xterm's own wrap, a padding space
  in tmux's captured rows). That spacer used to break the path mid-name and drop the head, so
  `…/超长目录…/报告.md` kept — and opened — only its tail. Both spacer kinds are now healed.
- **Tappable terminal paths now actually show their blue highlight.** The underline/chip that marks a path
  as tappable never rendered — `registerDecoration` is a *proposed* xterm API and the terminal was created
  without `allowProposedApi`, so every call threw and a broad catch swallowed it. Paths were tappable but
  looked like plain text (what colour they had was the program's own, e.g. Claude Code's). They now carry
  a soft blue wash behind the path, in every pane.
- **The highlight stays put while you scroll the history.** It was computed only for the bottom page
  (xterm's `baseY`) and rebuilt only when new output arrived — so a path scrolled up into the scrollback
  lost its wash. The whole buffer is scanned now, so every path is lit up front and simply rides the
  content as you scroll — no per-scroll rebuild, so it no longer flickers off mid-drag and reappears when
  you stop.

## [0.12.3] - 2026-07-11

### Added
- **Name a session when taking over an orphan.** The takeover sheet now has an editable name field for a
  new session (prefilled with the same `<agent>-<dir>-1` default the server would auto-pick), and the
  "continue on the computer" hint shows the exact command with the real name filled in — `handmux open
  <name>` instead of the old `tmux attach -t <session>` placeholder. A user-typed name is sanitized to
  tmux rules and gets a numeric suffix if it collides with an existing session.
- **Homebrew install for machines without Node.** `brew install handmux/tap/handmux` installs handmux
  plus Node and tmux in one command — the zero-prerequisite path for people without a Node toolchain
  (published via the new `handmux/homebrew-tap`). If you already have Node, `npm i -g handmux` stays the
  lighter option (it reuses your existing Node). Documented in the Quick start.

## [0.12.2] - 2026-07-11

### Fixed
- **A changed app icon / manifest now actually reaches returning users.** The server was sending every
  static file — including the hand-authored, stable-URL `icons/*`, `manifest.webmanifest` and favicon —
  as `Cache-Control: immutable, max-age=1y`, which is only correct for Vite's content-hashed `/assets/*`
  bundles. A stable-URL asset marked `immutable` gets pinned in every returning browser for a year, so a
  new icon or manifest would never show up. `staticCache.js` now pins only `/assets/*` and serves the
  stable-URL assets `no-cache` (revalidate → cheap 304 when unchanged, instant pickup when changed). A
  one-time `?v=2` on the icon / manifest / og-image references breaks browsers out of the already-cached
  `immutable` copies (index.html is `no-store`, so the new refs reach them immediately); Android updates
  an installed PWA's icon automatically, while an icon already on an iOS home screen is frozen at
  add-time and needs a one-time remove + re-add.
- **README banner's bottom corners are now rounded.** At an exact window==card fit, headless Chrome
  clipped the card's bottom rounding, so the lower two corners rendered square while the top two were
  round. The banner is now a fixed-size card centered in a taller window and centre-cropped back, so
  all four corners round.

## [0.12.1] - 2026-07-11

### Changed
- **New app icon / brand logo.** Swapped in a new glowing terminal-window mark and regenerated every
  brand surface from it — PWA/home-screen `icon-192`/`icon-512`, the 180px `apple-touch-icon`, the
  cold-launch boot splash, the landing-page header mark (`site/logo-mark.png`, a rounded app chip),
  the browser-tab favicon (`site/favicon.svg`, now the new mark), and the OG /
  Twitter share cards (en + zh, rebuilt from a reusable `tools/og` template). The push badge (a
  monochrome notification silhouette) is unchanged. The home-screen icon ships as both an `any`
  variant (full-bleed art for iOS / desktop) and a dedicated `maskable` variant with a safe-zone
  margin, so Android's adaptive-icon masking no longer crops or over-enlarges it.
- **Brand wordmark.** A two-tone “handmux” wordmark — rounded, single-story-a (self-hosted Fredoka),
  `hand` in white and `mux` in a teal→green gradient — now stands in for the old solid green pill and
  is used consistently across the landing header + footer, the OG / Twitter share cards, and the
  app's cold-launch boot splash. On the landing pages it's preloaded and set `font-display: block` so
  it paints in Fredoka directly, with no flash of a fallback font first.
- **README title is now the brand banner.** Both READMEs (en + zh) swap the plain-text `handmux`
  heading for a rendered banner (rounded terminal mark + the Fredoka two-tone wordmark on a dark card)
  — GitHub strips CSS + web-fonts from READMEs, so the branded title can only ship as an image.

## [0.12.0] - 2026-07-11

### Fixed
- **Back from a doc preview now retraces how you actually got there — and never exits the app.** Back
  used to force any open preview to the 目录 page of that file's directory, even when you never browsed
  there (opened straight from a terminal link or 最近). That invented level consumed the sheet's only
  history entry, so the NEXT Back — which should have minimized the sheet — fell out of the app
  entirely. The sheet now records each real forward action (a dir move, a preview opened from inside
  the sheet) and Back pops them in reverse: a doc opened from browsing returns to home exactly as you
  left it (最近 stays 最近), and a doc opened directly just hides the sheet in one press.

### Added
- **Feedback channels, linked from everywhere.** Settings gains a 反馈与交流 section — GitHub Issues
  (always) and the WeChat user group (zh locales) — and the same two channels are now in both READMEs,
  the landing page (new #community section with the group QR), the docs (Feedback section), and the
  GitHub issue chooser. The QR image lives only on the site, so rotating it never needs an app release.
- **The chat composer's unsent draft survives leaving the app.** Whatever is typed in the chat box is
  mirrored to local storage on every keystroke and written back into the box on the next open — so an
  accidental swipe-away, a tab kill, or a crash no longer eats a half-written prompt. Sending (or 填入)
  clears the stored draft along with the box.
- **Swipe now scrolls full-screen apps (vim / htop / less / mouse-mode TUIs), plus a page up/down button.**
  Those apps run on the terminal's alternate screen, which has no scrollback — so a vertical swipe used to
  have nothing to move and instead nudged the browser page a little (the nav chrome peeking in on old iOS).
  Now a vertical drag is forwarded to the app as scroll input: when it's reporting mouse (the usual case —
  mouse mode on), as real mouse-wheel events it scrolls on exactly like a desktop wheel; otherwise as arrow
  keys, which scroll any pager (less / man / git log) line-by-line (in an editor arrows move the cursor
  instead — the deliberate trade-off for making the common pager case swipe-scroll). The scrolled frame
  repaints immediately. A floating page up/down control (frosted capsule, right edge) is shown on every
  full-screen pane for precise, always-available paging. On the normal screen, swipe-scroll through the
  captured scrollback is unchanged. Server-side: the pane reports its mouse state (`#{mouse_any_flag}` /
  `#{mouse_sgr_flag}`) and a new `POST /api/scroll` injects wheel events — re-checking mouse mode before
  injecting so the escape bytes can never leak into a shell as literal text.

## [0.11.1] - 2026-07-09

### Fixed
- **CLI crashed on Node 18** — the 0.11.0 setup menu's prompt library (`@clack/prompts` 1.7) uses
  `util.styleText`, which only exists from Node 20.12, so `import` died before any command ran.
  Pinned to 0.11.0 — the last release without that import (every 1.x has it top-level); the prompt
  API we use is identical. CI now also tests Node 22.

## [0.11.0] - 2026-07-08

### Fixed
- **File browser refreshes its listing when you reopen the sheet.** The sheet stays mounted while
  minimized, so reopening to the same directory kept showing the listing captured on first open. Both the
  directory browser and the 最近 (recents) view now re-fetch on every reopen, so you see the current
  contents (a `cd`, new files, or a newly-opened doc) instead of a stale snapshot.
- **Chat mode: long-pressing a quick-command chip now types into the terminal, not the chat box.** These
  chips are terminal commands, so a long-press (edit-before-run) now types the command into the pane's input
  line without Enter — the same as command mode's hold — instead of staging it in the chat composer.
- **`handmux setup` on a running instance now actually applies your changes.** The run-action used to read
  "Save & start" even when handmux was already up — and picking it just re-ran `start`, which sees the
  running instance and does nothing (only tunnel/port changes were ever detected), so an edited name / push
  / voice / ssh setting was written to disk but silently never took effect. Now that action reads **"Save &
  restart (apply now)"** when an instance is running and performs a real stop→start into the new config;
  choosing plain **Save** while running prints "run `handmux restart` to apply" instead of "run start".

### Changed
- **Setup's `none` tunnel now reads "Direct" (直连), and its description is accurate.** The LAN-only option
  was labeled with the raw flag value `none`, which says nothing to a newcomer; the picker, the connection
  summary, and the welcome copy now call it **Direct / 直连** (the `--tunnel none` flag and config value are
  unchanged). Its hint no longer claims "same Wi-Fi only" — a direct connection also works when the machine
  has its own public IP — and the hub summary now says **no relay / 无中转** instead of "LAN".
- **Setup's language row is clearer about its scope and easy to spot.** It's relabeled **CLI language /
  命令行语言** — bilingual so either audience recognizes it even if the CLI is currently in the other
  language (switching re-localizes the whole hub on the spot), and scoped to handmux's own terminal output
  rather than the phone app. Moved to the bottom of the settings, just above the actions, since it's a tool
  preference rather than an app setting.
- **`handmux setup` push section now explains itself.** Turning notifications on shows a one-line note that
  handmux generates a private signing key locally (`~/.handmux/config.json`, never leaves the machine) and
  that the "contact" is only an address the push service can reach you at. The contact field is validated
  (must be a real `mailto:`/`https://`, `.local` rejected — Apple's APNs silently drops fake ones), and
  **Regenerate keys** now carries a "resets every phone subscription" hint and a confirm gate spelling out
  that every already-subscribed phone must re-subscribe (only needed if the private key leaked).
- **Tiered `handmux` help.** The bare `handmux` / `handmux help` screen is now short — the six verbs, the
  mental model, and a "New here? run `handmux setup`" nudge — with the full flag wall moved behind
  `handmux help flags`. That flag reference now doubles as the **headless config guide**: every flag lists
  its matching `HANDMUX_*` env var, and the precedence line is corrected to **flag > file > env > default**
  (env sits between file and default — it was previously mis-documented as "flag > file > default", which
  hid that env vars work at all). The rarely-needed `--static-dir` / `--upload-exts` / `--preview-ttl` are
  documented there too. Flags stay the scriptable/headless interface; `setup` remains the interactive
  path — neither replaces the other.
- **`handmux setup` is now a menu hub, not a linear questionnaire.** Every setting is a row showing its
  current value; arrow to a section to edit just that (Connection / Name / Port / Language / Push / Voice),
  then return to the hub and pick Save / Save & start / Exit. Re-configuring one thing no longer means
  Entering through every prompt. **Connection is two levels** — first pick the tunnel type (and, for
  cloudflare, temporary vs named), then that tunnel's config fields appear *inside* it as value-showing
  rows (secrets masked) you edit one at a time; **Push / Voice** are likewise mini-hubs over their current
  values instead of a "keep it? [y/n]" gate. cloudflare's quick vs named is now one **cloudflare** entry
  with the temporary-vs-named choice inside (mirroring natapp/cpolar's temporary-vs-fixed); the `--tunnel
  cloudflare` / `cloudflare-named` flags are unchanged at the config level. **Built for a newcomer who
  won't read docs**: a first run walks language → a one-line welcome → "how does your phone reach this
  machine?" (options framed by outcome — *works in China*, *no signup*, *simplest*), then lands the cursor
  on **Save & start** so the essentials are obviously done and the rest reads as optional; push/voice are
  described by what they do ("get pinged when an agent finishes", "talk to your phone → text") and the
  natapp/cpolar prompts say exactly where to register free and copy the authtoken. Enumerated choices are
  arrow-key selectable; inputs validate inline (port range, domain shape); Esc backs out a level. Built on
  `@clack/prompts`, isolated behind `src/cli/prompt.js`.

### Added
- **Two China-usable tunnels: `--tunnel natapp` and `--tunnel cpolar`.** When Cloudflare's edge is
  unreliable from mainland China, these ngrok-derived domestic tunnels get the phone to your machine.
  Unified, minimal parameter model: one shared `--authtoken` (or `HANDMUX_AUTHTOKEN`) is the only new
  required flag; a **fixed/reserved domain is just `--public-url`** (bare host accepted — normalised to
  `https://`), and omitting it uses the provider's free temporary domain (scraped from the client's
  output, like the Cloudflare quick tunnel). cpolar also takes an optional `--cpolar-region` (e.g. `cn`).
  cpolar's client **auto-downloads** (PATH → `~/.handmux/bin` → fetch+unzip, with a friendly manual
  fallback); natapp's is login-gated so it resolves an installed binary and otherwise tells you exactly
  where to drop it. `handmux setup` gained both as menu options 5/6, each with in-context guidance on
  where to get the authtoken and a temporary-vs-fixed-domain prompt.

## [0.10.0] - 2026-07-06

### Added
- **`handmux open <session>` — one-command attach on the computer.** Attaches the named tmux session,
  creating it if missing; inside tmux it refuses with a hint (don't nest tmux in tmux). Deliberately
  decoupled from the server lifecycle (never starts/stops anything) — its main job is taking back a
  session you created from the phone, without needing to know `tmux new -A -s`. The phone's bind/create
  dialog now carries a quiet hint teaching exactly that (all 5 languages), and the docs gained a
  `handmux open` section.

### Fixed
- **A document always shows the latest content now — no stale cached copy.** A doc tab cached the bytes
  it was first opened with; re-opening the same path only re-activated the tab and *discarded* the
  freshly-refetched content (`openDocState` dedupe), so an updated file kept showing the old version.
  Now every way of returning to a doc refetches it: re-tapping the file, **switching to its tab**, and
  re-opening the file sheet from the topbar. Tab switches stay instant (activate first, refresh in the
  background) and a refetch that lands after you've switched away updates the tab in place without
  stealing focus back. The refresh is a **conditional GET** keyed on the file's mtime: an unchanged
  file answers `{ notModified }` (text/markdown via `/api/file?mtime=`) or `304` (images via
  `/api/download?mtime=`, `X-Mtime` header carrying the current mtime) — so nothing is re-transferred
  or re-rendered when nothing changed (your scroll position and read-aloud stay put, and an unchanged
  image keeps its exact object URL: no re-download, no flash). A changed image swaps in a fresh blob
  and revokes the old one.

### Changed
- **The in-app changelog is now keyed by release version, not date.** Each entry carries a `version`
  (`0.9.1`) shown as "v0.9.1 · 2026-07-06", plus a one-line `highlight`; the pre-1.0 internal builds are
  merged into a single dateless "Early builds" entry. `LATEST_RELEASE` / the unread-dot id now use the
  version. (Existing users see the gear dot light once as the stored "seen" id switches format.)

### Added
- **The phone shows *what's new* before you upgrade, not just the version number.** The release now
  mirrors the changelog's concise per-version highlights into `server/package.json` `whatsNew` (via a
  new `server/scripts/gen-whatsnew.mjs`, run by `release.sh`). The existing hourly update check fetches
  it in the same `npm view handmux@latest version whatsNew --json` call — so it rides the user's own npm
  (China-mirror-friendly), no GitHub reach. `GET /api/version` returns `whatsNew` trimmed to the versions
  strictly newer than the installed one, and Settings lists them under the "vX available" card so a user
  knows what the trip to the computer buys before running `handmux update`.

## [0.9.1] - 2026-07-06

### Added
- **"Add to Home Screen" coach.** On first open in a browser tab (never once installed, and
  remembered as dismissed), a light, dismissible strip at the top of the screen nudges you to install
  handmux as a full-screen PWA — a non-modal `role="status"` banner you flick away with the ✕, not a
  blocking dialog. Android gets a one-tap install via `beforeinstallprompt`; iOS Safari gets the
  compact Share → More → Add to Home Screen hint, and other iOS browsers are pointed at Safari — the
  only iOS browser that can install a PWA, and the path iOS push requires.

## [0.9.0] - 2026-07-05

### Changed
- Chat composer: once the text grows past one line, the textarea takes the full pill width and the
  mic/send buttons float in the pill's bottom-right corner instead of reserving a right-hand column
  on every line; the box hugs the text, and only when the last line actually reaches the buttons
  does it open an extra strip for them (last-line position measured via a hidden mirror div). The
  pill also gained a little vertical breathing room above and below.
- The landing site moved to its own repo, `handmux/handmux.github.io` (still served at handmux.com);
  the code repo's `gh-pages` branch is retired once the domain cutover completes.
- The public repository moved to its own organization: `github.com/handmux/handmux`. Old
  `yuanyuanzijin/handmux` links redirect permanently; README badges, package metadata, the security
  policy, issue templates and the landing page now point at the new home.

### Fixed
- The bundled terminal fonts (Nerd icons / symbol fills) could stay missing for a whole session
  when their one network fetch failed on a flaky link — a failed `@font-face` is never retried by
  the browser. The app now supersedes a failed face with a fresh JS FontFace and retries with
  backoff, rebuilding the terminal glyph atlas when the font finally lands.

## [0.8.0] - 2026-07-05

### Added
- **Update notice on the phone: know when the installed CLI is behind npm.** A new token-gated
  `GET /api/version` returns `{ current, latest, updateAvailable }` — `current` is this server's installed
  version, `latest` comes from the same hourly npm cache the CLI keeps (`~/.handmux/update-check.json`),
  refreshed asynchronously (never blocking the request) when stale. The web app checks it **once per launch**
  (not polled): if a newer release exists, the settings gear lights its dot and Settings shows a
  「有新版本 vX 可用 · 在电脑上运行 `handmux update`」card (the upgrade is computer-side, so it's a notice,
  not a button). The gear's dot is shared with the changelog-unread signal — update-available before you
  upgrade, then the changelog it brought after — and clears once you've opened Settings for that version
  (`tw_version_seen`), relighting only when npm publishes a newer one. Settings also now shows the current
  version number.
- **Command mode: saved commands split into GLOBAL + THIS-WINDOW lists.** The command page's quick-bar
  now shows your global commands (grey, first) followed by the current tmux window's own commands (green),
  keyed by the stable window id. The trailing ＋ became a ⚙ that opens a taller editor with two sections,
  each reorderable with ▲▼. Adding lives in its own centred iOS-style card, opened by a ＋ in the editor
  header, so the panel itself is just a clean list; the card stacks its controls vertically (命令/按键 tab ·
  a 全局/窗口 segmented switch for which list · the field · an iOS toggle for 带回车) and rides above the
  soft keyboard instead of being pushed off-screen. **Tap any saved row to re-open the card pre-filled and
  edit it in place** (a key fav's chord is decoded back into its 粘滞键 + base key).
  - **命令**: type it; a 「带回车」toggle stores whether a tap types-and-runs it (shown with a trailing ⏎)
    or just types it into the shell.
  - **按键**: build a key combo (e.g. Ctrl+C) from a 粘滞键 dropdown (None / Ctrl / Shift / Alt / Ctrl+Shift
    / Ctrl+Alt, default None) + a base key (a letter, or a named key like `Up`/`Tab`); saved as a chip (⌃C)
    that fires the real terminal key on tap.
  The old flat command list carries over unchanged as the global one.
- **Chat mode: the quick-bar is now user-customizable, same as command mode.** A ⚙ at the end of the chat
  quick-bar opens the same centred iOS card editor (chat variant): a single global list, a 消息/按键 tab, and
  tap-a-row-to-edit + ▲▼ reorder. 消息 saves a line sent to the agent (a leading `/` marks it a slash-command,
  kind `cmd`, otherwise a `reply`); 按键 reuses the 粘滞键 + base-key pickers to bind a real terminal key
  (ESC, Tab, Ctrl+C, …). The seeded ESC/Tab/⌫ defaults are now proper key favs so they render and edit like
  any other. Chat has no per-window list and no 带回车 toggle (a chat tap always sends).
- **Video files are now uploadable.** The upload allow-list (both the `accept` hint and the server's
  `DEFAULT_UPLOAD_EXTS`) gained the common video extensions (`mp4`, `m4v`, `mov`, `webm`, `mkv`, `avi`,
  `wmv`, `flv`, `3gp`, `ogv`, `mpeg`, `mpg`).
- **Uploading a name that already exists auto-renames instead of failing.** The server picks the first
  free Finder-style `name (1).ext`, `name (2).ext`, … — it never overwrites, and the response carries the
  actual final name so the pasted path is correct. (Previously a clash returned 409 → a bare 「上传失败」.)
- **Git panel can browse repos outside `$HOME` (under `/tmp`, `$TMPDIR`).** It now shares the same
  multi-root allow-list the file/doc browser already used, so a repo an agent is working in under `/tmp`
  opens on the phone instead of erroring out.

### Changed
- **Touch targets raised toward the 44pt HIG minimum.** The file-browser bar's up/cwd/mkdir/upload squares
  are now 44×44, and list-row action icons (favourite/copy/delete/reorder, session unbind, idea delete, file
  download) get a ≥44pt-tall hit box while keeping their compact glyphs. The topbar stays deliberately compact
  — its icon buttons are a comfortable 34×34 (bigger than before, but the bar itself is tighter) with the
  unread badges re-anchored to hug each glyph. Also left compact: the command keyboard grid, window tabs,
  dock input buttons, quick-command chips and the preview head. CSS-only.
- **Sheet/modal close buttons unified to one iOS style.** Every panel's close control (`.settings-close`
  across the modals, `.cmd-close` across the bottom sheets) is now the same subtle filled-grey circle with a
  centred X — regardless of whether it renders the `✕` glyph or the `<XIcon/>` SVG — instead of a bare grey
  glyph at mixed sizes. Sheet titles aligned to 16px. CSS-only.
- **Segmented controls unified to one iOS style.** The settings preview-type switch (`.preview-seg`) and the
  file home-tab switch (`.file-seg`, 最近/新增) now use the same faint-track + raised-pill look as the saved-
  command editor's `.cmd-seg`, instead of three different bordered/boxed treatments. CSS-only, markup
  unchanged. Also bumped legacy 6px radii to 8px and softened bottom-sheet corners to 16px.
- **App-wide colour unification to iOS system accents.** Consolidated the scattered accent palette (7 blues,
  6 greens, 6 error reds) down to one system blue (`#0a84ff`), one green (`#34c759`) and one red (`#ff453a`),
  exposed as `:root` tokens (`--blue`/`--green`/`--red` + `-rgb` variants) and referenced throughout
  `styles.css`. Semantic colour sets (git badges, inbox states, chat-chip categories, usage gauge) are left
  intact. Pure restyle — no behaviour change.
- **Upload picker now filters to allowed types and rejects an unsupported pick up front.** Both upload
  entries (chat composer ＋附件 and the file-browser upload button) carry an `accept` hint (images +
  text/code + documents + video) so the native picker guides you toward valid files, and pre-check the
  picked files client-side: a disallowed pick (an executable, `.zip`, an extensionless binary) is
  dropped with an instant 「不支持的文件类型」note instead of failing halfway with a server 415. Mirrors
  the server's extension allow-list (`server/src/uploadTypes.js`), which remains the real enforcement.
- **Upload progress is honest, and the transfer is cancellable.** The bar used to jump to 100% the
  instant the browser flushed the bytes to the socket/proxy, then sit there through the real wait
  (server receive + disk write + response — the bulk of a big file behind nginx/a tunnel). It now runs
  in two phases: a real % while sending, then an indeterminate 「服务器接收中…」spinner once bytes are
  flushed. During a transfer an app-wide overlay blocks stray taps (HIG: don't leave a long op without an
  out) — the only control is **Cancel**, which aborts the in-flight request and stops the batch (files
  already uploaded are kept). Covers both upload entries (chat ＋附件 and the file browser).

### Fixed
- **Saved key combos with a modifier + a named key (Ctrl+Arrow, Ctrl+Tab, …) were silently dropped** — the
  `/keys` allowlist only accepted a modifier on a single letter/digit (`C-r`) or a bare named key (`Up`,
  `Tab`), so `C-Up`/`M-Up`/`C-Tab`/`C-S-Up` failed server-side validation and nothing reached tmux. The
  allowlist now permits any Ctrl/Alt/Shift prefix combo (canonical `C- M- S-` order) on a named key, so the
  按键 editor can bind Ctrl+Arrow, Alt+Arrow, Ctrl+Tab, Ctrl+Space, Alt+Enter, etc. (Plain arrows/Tab
  already worked — type the name, e.g. `Up` / `Tab`, as the base key.)
- **Swiping between key/chat mode leaked the other page** — the neighbouring page (e.g. chat's green
  chips) showed through at rest and the height mismatch read as a gap mid-swipe. The dock track is a
  composited layer (`will-change` + `translate3d`), and iOS Safari lets a composited child escape a plain
  `overflow: hidden` clip; adding `contain: paint` to `.dock-pager` forces it to clip the track.
- **History (send log) kept vanishing moments after a send** — the window-level history was keyed by the
  tmux window NAME, which tmux auto-renames to the running command; the moment the name changed the read
  key drifted and `getRecent` returned nothing, so the list "cleared itself." Now keyed by the stable
  window ID (`@N`) for both read and write.
- **Dock could get stuck resting between the two pages** — the swipe track's transform used to be
  imperative even at REST, and rest was only re-asserted on a React render (rare in command mode), so an
  interrupted gesture (browser-hijacked touch, missed `touchend`, or a press-and-hold on the ◀ arrow whose
  finger jittered) could leave it parked off a page boundary — half keyboard, half composer — with no way
  to recover. Root fix: the resting position is now owned by React/CSS (a `.at-chat` class → a CSS
  transform + transition); the finger drag only overrides with an inline transform that's cleared on
  release, so at rest the track is ALWAYS exactly on a page and can't get stuck. Also: a swipe only locks
  when the drag is clearly horizontal and past a 16px gate, so a key press no longer starts a page drag.
- **Agent logos (Claude/Codex) invisible in iOS home-screen PWA** — `AgentMark` was the only icon
  rendered as `<img src="data:image/svg+xml,…">`; iOS standalone WKWebView doesn't reliably render
  percent-encoded svg+xml data-URIs in `<img>`, so those two logos vanished while every other (inline
  `<svg>`) icon showed. Now inlined as a real DOM `<svg>` (`?raw` import), which every engine renders;
  still rides the content-hashed JS so a changed logo busts the cache.
- **Git panel showed a red error where it shouldn't.** A legit repo under `/tmp` (outside `$HOME`) failed
  with a red 「无法读取仓库」 (the git browser was still home-only while the file browser had moved to a
  multi-root allow-list — see Added). And picking a directory with no repo, or one genuinely outside the
  accessible area, rendered in the red error line too. Now: repos under `/tmp`/`$TMPDIR` just open;
  no-repo / out-of-scope are soft grey **instructive** notes (say why + what to do: pick another dir,
  `git init`, or move it under home) — red is reserved for real failures.
- **Upload failures now say why.** A failed upload showed a bare 「上传失败」; it now surfaces the specific
  reason (file too large, unsupported type, …) per file, in both the chat composer and the file browser.

### Changed
- **Chat composer: quick-command bar above the pill** — moved the ＋ upload and ▤ 常用 out of the input
  pill into a dedicated row above it. The row's left holds two fixed, text-only actions (`添加附件` ·
  `历史记录`, styled distinctly from the commands); its right is a horizontally-scrollable strip of
  user-editable vibe commands (`ESC 继续 ok 1 2 3 /compact …`). Tapping a command sends it immediately —
  `ESC` fires the Escape key (interrupt), the rest type + Enter. Add/remove commands via 历史记录 (they
  persist per-mode and feed the strip). The strip scrolls without hijacking the page swipe.
- **Command keyboard: two key rows + a quick-bar (mirrors the chat layout)** — the command keyboard is
  now a fixed **2×7 grid** (row 1 `Esc Tab ~ / ▲ @ ⌫`, row 2 `Ctrl Shift Alt ◀ ▼ ▶ Enter` — Esc/Tab
  top-left, ⌫ top-right, Enter bottom-right, the inverted-T arrows just left of it) above a **quick-bar**
  like chat's: its left is a fixed text button that **展开/收起键盘** (toggles the system keyboard, label
  follows state), its right a horizontally-scrollable strip of your **own saved commands** — a list kept
  **separate from** the chat one; tap = type + Enter into the shell (`ESC` fires the key), the trailing ＋
  adds/removes entries. All the buried shell symbols (`| \ _ > < & ; *`) are gone; only `~ / @` stay.
  Ctrl/Shift/Alt are still sticky modifiers — tap arms for the next key (composing `C-<x>` / `BTab` /
  `M-<x>` / `S-<arrow>`), double-tap locks. `/keys` accepts `C-`/`M-<letter|digit>` and `S-<arrow>`.
- **Multi-pane window tab is more compact** — the expanded `name │ ① cmd ▾` tab now caps the name and
  command widths (ellipsis) and tightens padding, so a long command no longer blows the tab wide. The
  full command still shows in the pane menu.
- **Multi-pane window tab is more compact** — the expanded `name │ ① cmd ▾` tab now caps the name and
  command widths (ellipsis) and tightens padding, so a long command no longer blows the tab wide. The
  full command still shows in the pane menu.

### Added
- **Command mode (type straight into the terminal)** — the dock now has two input modes. **Command**:
  every keystroke streams straight into the pane like a real shell (the capture field stays empty, the
  terminal is the display); the system keyboard's ⌫/↵ delete/run in the shell, an IME commits whole
  words, and an armed Ctrl composes the next typed letter into `C-<x>`. **Agent (chat)**: the existing
  multi-line composer for prose prompts (voice, upload, 常用). The mode defaults from whether a coding
  agent is live in the pane (`states.agent`) and sticks per-pane; switch it with the `命令 | 对话`
  segmented control or by tapping the terminal body (which drops into command mode and pops the keyboard).
  (Optimistic at-cursor echo is a later stage — for now a typed char appears after one round-trip.)
- **「常用」drawer (mode-aware, customizable)** — the 常用 button opens a bottom drawer whose contents
  follow the mode: **agent** shows one-tap reply chips (ok / 继续 / yes / no) and Claude slash-commands
  (`/compact` `/clear` `/model`); **command** shows your saved commands. Tap sends immediately; you can
  add and delete your own entries, kept in two separate per-mode lists.
- **Usage bars: time-progress marker** — each quota bar now draws a thin vertical line at the fraction
  of its reset window that has elapsed. Usage fill left of the line = burning slower than the clock;
  past it = faster. Derived from `resetsAt` + the window length (Claude 5h/weekly; Codex `windowMinutes`).

## [0.7.0] - 2026-07-03

### Added
- **Usage page (per-agent quota/limits)** — a new top-bar page shows Claude's 5-hour and weekly
  rate-limit bars (with reset countdowns) and Codex's quota windows, read entirely from local
  files on the host — no account login, no API calls. `GET /api/usage`. Codex is zero-config (its
  rollout's `token_count` events carry `rate_limits` + cumulative tokens). Claude's 5h/weekly %
  live only in Claude Code's statusLine stdin (the one documented local source — see
  code.claude.com/docs/en/statusline), so a new `handmux-statusline.cjs` capturer snapshots them
  to `~/.handmux/claude-usage.json`. Installing it is opt-in via `handmux setup` / `hooks install`
  and **non-destructive**: it only auto-installs when no statusLine exists; an existing custom
  statusLine is never clobbered (the CLI prints a one-line TEE compose snippet instead). Uninstall
  reverts only our own.

### Removed
- **The per-window tmux status dot is gone.** The Claude hook used to also write a colour into each
  tmux window's `@claude_dot` option, and `handmux setup`/`hooks install` offered to patch
  `~/.tmux.conf` to render it. It's removed end-to-end (writer, `~/.tmux.conf` patcher, seed/seen
  scripts, CLI offer, docs): it was Claude-only (no Codex), keyed per-window while agents run
  per-pane (so it mis-rendered with split panes), went stale on hard-kills, and overwrote your PC's
  tmux status bar — all to duplicate, worse, what the phone inbox already shows accurately.

### Changed
- **`handmux setup` defaults a new user to the zero-config tunnel** — the tunnel prompt now defaults
  to `cloudflare` (quick tunnel, instant public URL) for a first-time user with no config, instead of
  `cloudflare-named` (which a bare-Enter newcomer can't finish without a Cloudflare login + their own
  domain). Re-running `setup` still defaults to your current tunnel.

## [0.6.0] - 2026-07-03

### Added
- **Codex CLI support (second agent)** — handmux is no longer Claude-only. A new agent-driver
  registry (`server/src/agents/`) lets the inbox, push, and orphan/takeover engine drive any
  coding agent through a descriptor; Claude Code and OpenAI's Codex CLI are the first two.
  `handmux hooks install` now wires both. Codex 0.142+ ships a Claude-parity hook system (same
  events, same stdin payload fields), so handmux registers Codex's lifecycle hooks in
  `~/.codex/config.toml` (a marked region, appended alongside any hooks you already have) and
  reuses the exact Claude hook scripts + classifier — giving the phone full working / 需要你 /
  done states for Codex, not just turn-done. Orphan Codex sessions running outside tmux can be
  taken over with `codex resume`. New `codex` startup-command preset; the inbox/enable copy now
  says "AI session" rather than "Claude". Validated end-to-end against Codex 0.142.5: the
  `UserPromptSubmit`→working and `Stop`→done hooks fire, `$TMUX_PANE` is inherited (state keyed
  to the right pane), payloads are Claude-shaped, and `codex resume`/rollout-cwd resolution parse
  as expected. A codex pane reports `pane_current_command` as its Node launcher (`node`), so
  inbox liveness matches that too (else codex panes were pruned). Every inbox row and the
  current-session topbar now show a per-agent mark (Claude / Codex) so the two are
  distinguishable at a glance. Approving a Codex permission flips the pane straight back to
  进行中 (a PostToolUse un-stick that no-ops mid-turn, so it doesn't fire on every command).
- **CLI now speaks Chinese** — the `handmux` command-line output (help, `start`/`status`/
  `setup` prompts, errors, the access block) is fully localized. Language resolves from
  `--lang en|zh`, a `"lang"` field in the config, or the shell locale (`LANG`/`LC_*` = `zh…`),
  defaulting to English. `handmux setup` now asks for the language first, and `handmux config`
  shows the resolved `lang`.
- **Take over Claude sessions running outside tmux** — the inbox now detects `claude`
  processes that aren't in a tmux pane (so handmux can't steer them) and lists them in a
  collapsible footer with each session's working dir, idle/busy state, and last message. One
  tap opens a takeover sheet: resume the session in a fresh tmux session (or a new window of
  an existing one) via `claude --resume`, optionally ending the original process (default on —
  a resumed session shares the same history file, so a single writer avoids corruption). New
  `GET /api/orphans` + `POST /api/orphans/takeover`. Detection is a process scan (ps + tmux +
  lsof), skipping Ctrl-Z-suspended and background sessions.
- **Upgrade notice + `handmux update`** — `handmux start`/`status` now show a one-line
  "⬆ handmux X.Y.Z available" hint when a newer version is published, and `handmux update`
  (alias `upgrade`) runs the global install for you. The check never blocks or touches the
  network on the hot path: it prints from a once-a-day cache and refreshes in a detached
  background worker, and the version query goes through the user's own `npm` (so it honours a
  configured China mirror / private registry rather than hard-coding registry.npmjs.org).
- **Windows / WSL2 install docs** — README (en + zh) and the landing-page docs now have a
  Windows section: handmux is Unix-only (tmux), so run it inside WSL2, with the two WSL-specific
  gotchas called out — use `--tunnel cloudflare` (WSL2's NAT'd IP breaks the LAN URL) and enable
  systemd in `/etc/wsl.conf` for `handmux service` autostart.

### Changed
- **cloudflared auto-download shows progress** — the first-run `cloudflared` fetch used to buffer
  the whole binary silently, so on a slow link it looked hung. It now streams with a live
  `cloudflared  45%  (9.2/20.4 MB)` line (TTY only; piped output is left clean).
- **Bind-session is now a picker, not a text field** — the bind dialog lists the sessions that
  exist on the host (already-bound ones hidden) as tappable chips; pick one and confirm to bind
  it. A `＋ new session` chip flips the card into the create form (name + start dir + startup
  command). No more typing a name to guess whether it exists, and the misleading "short name"
  placeholder is gone.
- **`handmux start` on an already-running instance is clearer** — instead of a terse "already
  running — use restart", it now reassures when this run's config matches what's live, and when
  it differs (e.g. you changed `--tunnel`) it spells out the difference and offers to restart
  into it (interactive only; non-TTY just prints the `handmux restart` hint). `start` still never
  disrupts a running instance without an explicit yes.

## [0.5.3] - 2026-06-29

### Fixed
- **Git panel: bound repos reset to the default on every reopen** — repos added to a
  window were silently dropped, so reopening the panel fell back to the auto-discovered
  directory. Root cause: a legacy flat-array value under the per-window storage key made
  `readMap` return an array; subsequent writes set an array property that `JSON.stringify`
  drops, so every save vanished. `readMap` now coerces non-object values to `{}`, so
  per-window writes persist. Repos added to a window now survive close/reopen.

### Changed
- **Settings → Language label** — non-English locales now append "Language" to the setting
  label so the option is recognisable regardless of the current UI language.

## [0.5.1] - 2026-06-28

### Added
- **i18n: Traditional Chinese, Japanese, Korean** — three new UI locales; switch in
  Settings → Language. zh-TW browser-language detection also fixed.
- **Idea count badge** — the lightbulb topbar icon shows a count badge when there are
  pending ideas for the current window; count is also shown in the Ideas panel header.
- **Column-width fine control** — Settings now shows the live column count between the
  resize buttons, and adds ±1 buttons alongside the existing ±10 for precise adjustment.
- **SVG icons in command panel** — replaced Unicode glyphs (▤ / ★ / ☆ / ✕) with
  Lucide-style stroke SVGs consistent with the rest of the app's icon set.

### Fixed
- **tmux copy-mode blocks mobile input** — if the PC terminal was in copy/scroll mode,
  text and keys sent from the phone were silently swallowed. The server now exits
  copy-mode (`Escape`) before forwarding any input.
- **"Back to bottom" button** — appeared even when content didn't fill the screen; also
  clicking it during a momentum fling stopped the scroll without reaching the bottom.
  Both are now correct.
- **Boot flash of unstyled content** — on slow connections the boot splash could fade
  before the stylesheet arrived, briefly showing a white unstyled page. The splash now
  waits for the CSS `load` event before hiding.
- **Bind session errors when tmux has no sessions** — `list-sessions` exits non-zero
  when tmux hasn't been started; the server was propagating this as a 500. It now
  returns `[]` so the bind dialog offers to create a new session instead of erroring.

## [0.5.0] - 2026-06-28

First public release.

### Added
- `handmux` CLI: `start` / `stop` / `restart` / `status` / `logs` / `setup` / `config`,
  plus `hooks install|uninstall` and `service install|uninstall` (launchd on macOS,
  `systemd --user` on Linux). `--version` / `-v` prints the version.
- Pluggable tunnel drivers: `none` (default — local/LAN only, nothing exposed) and
  `cloudflare` (free quick tunnel; `cloudflared` is auto-downloaded if missing).
  `ssh` self-hosted tunnel is reserved (engine: `tunlite run`).
- Single supervisor process owns the server and the tunnel as children, restarts them
  with backoff, and records the live public URL into `~/.handmux/state.json`.
- Auth token is always materialised (generated when unset) and baked into the QR for
  one-tap sign-in; the printed plain links stay token-free so they're safe to share.
- Config resolution: flags > `~/.handmux/config.json` > env > defaults.
- Startup tmux check: hard error if tmux is absent, warning if it's older than the tested
  minimum (3.0) — since `capture-pane -e -N` rendering behaviour drifts across tmux versions.
- Test guard `capture-pane keeps SGR (-e) and trailing whitespace (-N)` so that drift surfaces
  as a named failure rather than a mobile-render glitch.
