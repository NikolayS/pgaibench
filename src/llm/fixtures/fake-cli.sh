#!/usr/bin/env bash
# Fake codex / claude binary for tests: records each call under $FAKE_DIR
# and replays out.N / err.N / code.N (or out.last ...). No model call.
# The record dir is ../rec next to the binary (the child env is an allowlist,
# so FAKE_DIR may not reach us); FAKE_DIR still wins when it is set.
v="FAKE_DIR_$(basename "$0")"; d="${!v:-${FAKE_DIR:-}}"
[ -n "$d" ] || d="$(cd "$(dirname "$0")/.." && pwd)/rec"
if [ "${1:-}" = "--version" ]; then cat "$d/version" 2>/dev/null || printf '%s\n' "${FAKE_VERSION:-fake 0.0.1}"; exit 0; fi
if [ "${1:-}" = "features" ] && [ "${2:-}" = "list" ]; then
  cat "$d/features" 2>/dev/null || printf 'shell_tool                               stable             true\nfast_mode                                stable             true\n'; exit 0
fi
if [ "${1:-}" = "debug" ] && [ "${2:-}" = "models" ]; then
  echo "debug:$CODEX_HOME:$(ls -A "$CODEX_HOME" | tr '\n' ',')" >> "$d/debuglog"
  cat "$d/catalog" 2>/dev/null || echo '{"models":[{"slug":"m","multi_agent_version":"v2","tool_mode":"code_mode_only","experimental_supported_tools":["clock"],"base_instructions":"B"}]}'; exit 0
fi
# Offline tool-list check (not counted as a call): record argv, env and the
# temp login under cap*, post the stored body (or a tool-free one) to openai_base_url.
for a in "$@"; do case "$a" in openai_base_url=*) u="${a#openai_base_url=}"; u="${u%\"}"; u="${u#\"}"
  printf '%s\n' "$@" > "$d/capargs"; env > "$d/capenv"; cp "$CODEX_HOME/auth.json" "$d/capauth" 2>/dev/null; cp "$CODEX_HOME/catalog.json" "$d/capcatalog" 2>/dev/null
  b="$d/capture.body"; [ -f "$b" ] || { b="$d/capture.default"; e=$(printf '%s\n' "$@" | sed -n 's/^model_reasoning_effort="\(.*\)"$/\1/p'); echo '{"model":"m","tools":[],"reasoning":{"effort":"'"$e"'"},"input":[{"type":"message","role":"user"}]}' > "$b"; }
  [ -f "$d/capture.none" ] || curl -s --noproxy '*' -X POST -H 'content-type: application/json' --data-binary @"$b" "$u/responses" > /dev/null
  exit 0;; esac; done
n=$(( $(cat "$d/n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$d/n"
printf '%s\n' "$@" > "$d/args.$n"
cat > "$d/stdin.$n"
env > "$d/env.$n"
pwd > "$d/cwd.$n"; ls -A | wc -l | tr -d ' ' > "$d/cwdcount.$n"
if [ -n "${CODEX_HOME:-}" ]; then (cd "$CODEX_HOME" && ls -A) > "$d/codexhome.$n"; stat -f %Lp "$CODEX_HOME/auth.json" > "$d/authmode.$n" 2>/dev/null; cp "$CODEX_HOME/auth.json" "$d/auth.$n" 2>/dev/null; cp "$CODEX_HOME/catalog.json" "$d/catalog.$n" 2>/dev/null; echo "$CODEX_HOME" > "$d/codexhomepath.$n"; fi
prev=""
for a in "$@"; do
  case "$a" in model_instructions_file=*) f="${a#model_instructions_file=}"; f="${f%\"}"; f="${f#\"}"; cp "$f" "$d/instr.$n";; esac
  if [ "$prev" = "--system-prompt-file" ]; then cp "$a" "$d/instr.$n"; fi
  prev="$a"
done
# N3: simulate a token refresh in the temp login copy, and a change of the real login meanwhile.
if [ -n "${CODEX_HOME:-}" ] && [ -f "$d/refresh.$n" ]; then cp "$d/refresh.$n" "$CODEX_HOME/auth.json"; fi
if [ -f "$d/sourcechange.$n" ]; then cp "$d/sourcechange.$n" "$(cat "$d/sourcepath")"; fi
if [ -f "$d/sleep.$n" ]; then sleep "$(cat "$d/sleep.$n")"; fi
if [ -f "$d/hang" ]; then sleep 8 & echo $! > "$d/childpid.$n"; sleep 8; fi
k=$n; [ -f "$d/out.$k" ] || [ -f "$d/code.$k" ] || k=last
[ -f "$d/err.$k" ] && cat "$d/err.$k" >&2
[ -f "$d/out.$k" ] && cat "$d/out.$k"
exit "$(cat "$d/code.$k" 2>/dev/null || echo 0)"
