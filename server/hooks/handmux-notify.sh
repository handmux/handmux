#!/bin/sh
# handmux 上报 hook. $1 = stop | notify | prompt | end | resume | permreq | compacting | compact | stopfail.
# (compacting/compact/stopfail 是版本门控事件:PreCompact/PostCompact/StopFailure，只在够新的 Claude 上注册。)
# stdin = Claude Code 原始 payload(JSON).
# (resume  = PostToolUse on AskUserQuestion/ExitPlanMode:答完选项/批准计划 → 状态翻回进行中、带所选项。)
# (permreq = PermissionRequest:真实弹框一出现就发、带 tool_name → 比 permission_prompt 早亮「需要你」。)
# 只做本地落盘:更新 JSON latest state,并在启用时追加有界 Bridge event spool。不联网、
# 不依赖服务进程是否在跑 → 永不阻塞 Claude(始终 exit 0)。服务端/Connector 稍后消费这些文件。
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
# Capture the owning Claude process rather than this short-lived Hook process. The fingerprint lets the
# Connector reject an offline event after tmux has reused the pane for a different Claude generation.
# Missing/incomplete identity is intentionally tolerated for older Claude/platform variants: the writer
# then omits the additive field and the legacy latest-state path keeps working.
CLAUDE_PID=''
CLAUDE_STARTED_AT=''
CLAUDE_TTY=''
# Claude runs configured hooks asynchronously and may reparent the short-lived shell before it starts, so
# PPID is not authoritative. Resolve the exact `claude` process on this tmux pane's TTY first;
# retain ancestor walking only as a fallback for platforms where tmux/targeted ps is unavailable.
PANE_TTY=$(tmux display-message -p -t "$PANE" '#{pane_tty}' 2>/dev/null || printf '')
if [ -n "$PANE_TTY" ]; then
  # During an async Hook Claude may block waiting for the child and temporarily lose the foreground `+`.
  # Prefer the sole exact process; if more than one exact Claude shares the TTY, require one foreground owner.
  CLAUDE_PROCESSES=$(ps -t "${PANE_TTY#/dev/}" -o pid=,stat=,comm= 2>/dev/null || printf '')
  CLAUDE_PID=$(printf '%s\n' "$CLAUDE_PROCESSES" \
    | awk '$3 == "claude" { count += 1; only = $1 } END { if (count == 1) print only }')
  if [ -z "$CLAUDE_PID" ]; then
    CLAUDE_PID=$(printf '%s\n' "$CLAUDE_PROCESSES" \
      | awk '$3 == "claude" && $2 ~ /\+/ { count += 1; only = $1 } END { if (count == 1) print only }')
  fi
fi
if [ -z "$CLAUDE_PID" ]; then
  ANCESTOR_PID=$PPID
  ANCESTOR_DEPTH=0
  while [ -n "$ANCESTOR_PID" ] && [ "$ANCESTOR_PID" -gt 1 ] 2>/dev/null && [ "$ANCESTOR_DEPTH" -lt 32 ]; do
    ANCESTOR_COMMAND=$(ps -p "$ANCESTOR_PID" -o comm= 2>/dev/null || printf '')
    ANCESTOR_COMMAND=${ANCESTOR_COMMAND##*/}
    if [ "$ANCESTOR_COMMAND" = 'claude' ]; then
      CLAUDE_PID=$ANCESTOR_PID
      break
    fi
    ANCESTOR_PID=$(ps -p "$ANCESTOR_PID" -o ppid= 2>/dev/null | tr -d ' ')
    ANCESTOR_DEPTH=$((ANCESTOR_DEPTH + 1))
  done
fi
if [ -n "$CLAUDE_PID" ]; then
  # `lstart` follows the process locale on macOS; force C so standalone Node can parse it consistently.
  CLAUDE_STARTED_AT=$(LC_ALL=C ps -p "$CLAUDE_PID" -o lstart= 2>/dev/null || printf '')
  CLAUDE_TTY=$(ps -p "$CLAUDE_PID" -o tty= 2>/dev/null || printf '')
fi
# payload 经 stdin 原样流给 node(不在 shell 里转义,避免坏数据);pane 含 '%' 直接进 JSON 字段,
# 不再进 URL → 彻底告别旧的 "%110 被 url-decode 丢弃" 那类坑。
node "$(dirname "$0")/handmux-write.cjs" "$FILE" "$PANE" "$1" "$TS" "$HOST" \
  "${HANDMUX_CLAUDE_EVENTS:-}" "$CLAUDE_PID" "$CLAUDE_STARTED_AT" "$CLAUDE_TTY" 2>/dev/null || true
exit 0
