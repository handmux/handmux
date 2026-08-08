#!/bin/sh
# handmux 上报 hook. $1 = stop | notify | prompt | end | resume | permreq | compacting | compact | stopfail.
# (compacting/compact/stopfail 是版本门控事件:PreCompact/PostCompact/StopFailure，只在够新的 Claude 上注册。)
# stdin = Claude Code 原始 payload(JSON).
# (resume  = PostToolUse on AskUserQuestion/ExitPlanMode:答完选项/批准计划 → 状态翻回进行中、带所选项。)
# (permreq = PermissionRequest:真实弹框一出现就发、带 tool_name → 比 permission_prompt 早亮「需要你」。)
# 只做一件事:把本次事件写进一个本地 JSON 状态文件(键=tmux pane,值=该 pane 最新事件)。不联网、
# 不依赖服务进程是否在跑 → 永不阻塞 Claude(始终 exit 0)。服务端按需读这个文件(见 claudeEvents.js)。
# 真正的读-改-写交给同目录的 handmux-write.js(node:真 JSON 解析 + 文件锁,多 pane 并发 hook 不丢更新)。
CFG="$(dirname "$0")/handmux-notify.env"
[ -f "$CFG" ] && . "$CFG"
PANE="${CLAUDE_PANE:-$TMUX_PANE}"
[ -z "$PANE" ] && exit 0   # 不在 tmux 里(没有 pane 可定位)→ 暂不记录
FILE="${HANDMUX_STATE:-$HOME/.claude/handmux-state.json}"
# 毫秒时间戳:与旧实现的 Date.now() 同单位(客户端已阅水位线兼容)。优先 perl,退化到 秒×1000。
TS=$(perl -MTime::HiRes -e 'printf "%.0f", Time::HiRes::time()*1000' 2>/dev/null)
[ -z "$TS" ] && TS=$(( $(date +%s) * 1000 ))
HOST=$(hostname 2>/dev/null || printf '')
# payload 经 stdin 原样流给 node(不在 shell 里转义,避免坏数据);pane 含 '%' 直接进 JSON 字段,
# 不再进 URL → 彻底告别旧的 "%110 被 url-decode 丢弃" 那类坑。
node "$(dirname "$0")/handmux-write.cjs" "$FILE" "$PANE" "$1" "$TS" "$HOST" 2>/dev/null || true
exit 0
