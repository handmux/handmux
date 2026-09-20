#!/bin/sh
# handmux 上报 hook(CodeBuddy Code). $1 = 事件 src 名:
#   start(SessionStart) | prompt(UserPromptSubmit) | stop(Stop) | end(SessionEnd) | notify(Notification)
#   | resume(PostToolUse on the interaction tools) | permreq(PermissionRequest) | permdenied(PermissionDenied) | compacting(PreCompact)
#   | compact(PostCompact) | stopfail(StopFailure)
# stdin = CodeBuddy 原始 payload(JSON).
# 只做本地落盘:更新 JSON latest state,并在启用时追加有界 Bridge event spool。不联网、不依赖服务进程
# 是否在跑 → 永不阻塞 CodeBuddy(始终 exit 0)。服务端/Connector 稍后消费这些文件。
# 真正的读-改-写交给同目录的 handmux-write.cjs(node:真 JSON 解析 + 文件锁,多 pane 并发 hook 不丢更新)。
# 与 Claude 版(handmux-notify.sh)的差别只有三处:配置目录、事件名表、进程身份判定 —— 详见各自注释。
HANDMUX_AGENT=codebuddy
export HANDMUX_AGENT
CFG="$(dirname "$0")/handmux-codebuddy-notify.env"
[ -f "$CFG" ] && . "$CFG"
PANE="$TMUX_PANE"
[ -z "$PANE" ] && exit 0   # 不在 tmux 里(没有 pane 可定位)→ 暂不记录
# The installer registers the canonical src as the command's argument. Accept the raw hook event name too:
# a hand-written or project-level settings.json can then point straight at `<script> <EventName>`, and both
# spellings collapse into the one vocabulary the Connector reads. Anything else is not ours → touch nothing.
case "$1" in
  start|prompt|stop|end|notify|resume|permreq|permdenied|compacting|compact|stopfail) SRC="$1" ;;
  SessionStart) SRC='start' ;;
  UserPromptSubmit) SRC='prompt' ;;
  Stop) SRC='stop' ;;
  SessionEnd) SRC='end' ;;
  Notification) SRC='notify' ;;
  # The user answered a question or approved a plan: the wait is over and the turn continues. Registered with
  # a matcher, so this only ever fires for those two tools.
  PostToolUse) SRC='resume' ;;
  PermissionRequest) SRC='permreq' ;;
  PermissionDenied) SRC='permdenied' ;;
  PreCompact) SRC='compacting' ;;
  PostCompact) SRC='compact' ;;
  StopFailure) SRC='stopfail' ;;
  *) exit 0 ;;
esac
FILE="${HANDMUX_STATE:-$HOME/.codebuddy/handmux-state.json}"
# 毫秒时间戳:与旧实现的 Date.now() 同单位(客户端已阅水位线兼容)。优先 perl,退化到 秒×1000。
TS=$(perl -MTime::HiRes -e 'printf "%.0f", Time::HiRes::time()*1000' 2>/dev/null)
[ -z "$TS" ] && TS=$(( $(date +%s) * 1000 ))
HOST=$(hostname 2>/dev/null || printf '')
# Capture the owning CodeBuddy process rather than this short-lived Hook process. The fingerprint lets the
# Connector reject an offline event after tmux has reused the pane for a different CodeBuddy generation.
# Missing/incomplete identity is intentionally tolerated for older CodeBuddy/platform variants: the writer
# then omits the additive field and the legacy latest-state path keeps working.
CODEBUDDY_PID=''
CODEBUDDY_STARTED_AT=''
CODEBUDDY_TTY=''
# CodeBuddy's process is a Node CLI whose comm is meaningless for identity (`node`, or a version string), so
# this hook matches the COMMAND LINE instead. A row is CodeBuddy when its PROGRAM token is one of the
# published launchers (`codebuddy`, `codebuddy-code`, `cbc` — the native build) or when `node` runs a
# CodeBuddy entry point (the npm layout: `node …/@tencent-ai/codebuddy-code/bin/codebuddy`).
#   The match is deliberately NOT a substring over the whole line: this hook's own path lives under
#   ~/.codebuddy/, and CodeBuddy runs configured hooks through a wrapper that names that path — a whole-line
#   match would crown that short-lived wrapper as the session owner. Only the program/entry tokens are read.
#   Input rows are `pid command…`; the pid prints only when EXACTLY ONE row matches, so an ambiguous pane
#   stays unresolved and the writer omits the fingerprint instead of pinning a wrong process generation.
CODEBUDDY_OWNER_AWK='
  function base(value) { sub(/.*\//, "", value); return value }
  function is_codebuddy(   i, program, entry) {
    program = $2
    sub(/^-/, "", program)
    program = base(program)
    if (program == "codebuddy" || program == "codebuddy-code" || program == "cbc") return 1
    if (program != "node") return 0
    for (i = 3; i <= NF; i++) {
      if ($i ~ /^-/) continue
      entry = base($i)
      return (entry == "codebuddy" || entry == "codebuddy-code" || entry == "cbc") ? 1 : 0
    }
    return 0
  }
  { if (is_codebuddy()) { count += 1; only = $1 } }
  END { if (count == 1) print only }
'
# Walk up from PPID first: it needs no tmux round-trip and, for a synchronous hook, names the Agent exactly.
# The depth cap keeps a reparented/corrupted chain (PID 1 loops, container init) from spinning forever.
ANCESTOR_PID=$PPID
ANCESTOR_DEPTH=0
while [ -n "$ANCESTOR_PID" ] && [ "$ANCESTOR_PID" -gt 1 ] 2>/dev/null && [ "$ANCESTOR_DEPTH" -lt 32 ]; do
  ANCESTOR_COMMAND=$(ps -p "$ANCESTOR_PID" -o command= 2>/dev/null || printf '')
  if [ -n "$ANCESTOR_COMMAND" ]; then
    CODEBUDDY_PID=$(printf '%s %s\n' "$ANCESTOR_PID" "$ANCESTOR_COMMAND" | awk "$CODEBUDDY_OWNER_AWK")
  fi
  [ -n "$CODEBUDDY_PID" ] && break
  ANCESTOR_PID=$(ps -p "$ANCESTOR_PID" -o ppid= 2>/dev/null | tr -d ' ')
  ANCESTOR_DEPTH=$((ANCESTOR_DEPTH + 1))
done
if [ -z "$CODEBUDDY_PID" ]; then
  # CodeBuddy runs configured hooks asynchronously, so the short-lived shell may already have been
  # reparented. The pane's own TTY is still authoritative: scan it and take the single CodeBuddy row.
  PANE_TTY=$(tmux display-message -p -t "$PANE" '#{pane_tty}' 2>/dev/null || printf '')
  if [ -n "$PANE_TTY" ]; then
    CODEBUDDY_PID=$(ps -t "${PANE_TTY#/dev/}" -o pid=,command= 2>/dev/null \
      | awk "$CODEBUDDY_OWNER_AWK")
  fi
fi
if [ -n "$CODEBUDDY_PID" ]; then
  # Start time in the same form the server reads (processStartedAt in tmuxRuntime.ts): the raw procfs start
  # tick where procfs exists, otherwise the `lstart` string. A wall-clock `lstart` moves whenever the host
  # steps the guest clock (WSL2), which makes one live process look like several. The proc root is
  # overridable so tests can supply a fixture instead of the host's live process table.
  PROC_ROOT="${HANDMUX_PROC_ROOT:-/proc}"
  # comm may contain spaces/parentheses: drop "pid (comm) " first, then starttime is field 20.
  CODEBUDDY_STARTED_AT=$(sed 's/.*) //' "$PROC_ROOT/$CODEBUDDY_PID/stat" 2>/dev/null \
    | awk '{ print $20 }' 2>/dev/null || printf '')
  if [ -z "$CODEBUDDY_STARTED_AT" ]; then
    # `lstart` follows the process locale on macOS; force C so standalone Node can parse it consistently.
    CODEBUDDY_STARTED_AT=$(LC_ALL=C ps -p "$CODEBUDDY_PID" -o lstart= 2>/dev/null || printf '')
  fi
  CODEBUDDY_TTY=$(ps -p "$CODEBUDDY_PID" -o tty= 2>/dev/null || printf '')
fi
# payload 经 stdin 原样流给 node(不在 shell 里转义,避免坏数据);pane 含 '%' 直接进 JSON 字段,不再进 URL。
node "$(dirname "$0")/handmux-write.cjs" "$FILE" "$PANE" "$SRC" "$TS" "$HOST" \
  "${HANDMUX_CODEBUDDY_EVENTS:-}" "$CODEBUDDY_PID" "$CODEBUDDY_STARTED_AT" "$CODEBUDDY_TTY" 2>/dev/null || true
exit 0
