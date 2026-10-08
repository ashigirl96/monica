#!/usr/bin/env bash
# codex-return.sh show|wait <owner>/<repo> <PR> <requested_at>
#   show: requested_at より後の codex の返却を {"issue":[…],"inline":[…]} で出す。
#   wait: 返却が出るまで 5 秒おきに見て、returned / pending / error: … の 1 行を出す。
set -uo pipefail

mode=$1 repo=$2 pr=$3 since=$4
issue_url="repos/$repo/issues/$pr/comments?since=$since&per_page=100"
inline_url="repos/$repo/pulls/$pr/comments?since=$since&per_page=100"

# 依頼の直後に codex が作る進み具合の表は、返却に数えない。
filters='
def codex: map(select(.user.login == "chatgpt-codex-connector[bot]" and .created_at > $since));
def issue: codex | map(select(.body | startswith("<!-- codex-pull-request-review-summary -->") | not) | {id, body: .body[0:300]});
def inline: codex | map({id, path, line, body});
'

returns() {
  jq -n --arg since "$since" --argjson issue "$1" --argjson inline "$2" \
    "$filters"'{issue: ($issue | issue), inline: ($inline | inline)}'
}

if [ "$mode" = show ]; then
  returns "$(gh api "$issue_url")" "$(gh api "$inline_url")"
  exit
fi

err=$(mktemp)
trap 'rm -f "$err"' EXIT

etag_issue='' etag_inline='' body_issue='[]' body_inline='[]'

# If-None-Match に 304 が返った問い合わせは、GitHub のレート制限を使わない。
fetch() {
  local etag_var="etag_$1" resp status
  local args=(--include)
  if [ -n "${!etag_var}" ]; then args+=(-H "If-None-Match: ${!etag_var}"); fi
  resp=$(gh api "${args[@]}" "$2" 2>"$err" | tr -d '\r')
  status=$(head -1 <<<"$resp" | cut -d' ' -f2)
  case $status in
    304) ;;
    200)
      printf -v "$etag_var" '%s' "$(awk 'tolower($1) == "etag:" { print $2; exit }' <<<"$resp")"
      printf -v "body_$1" '%s' "$(awk 'body { print } /^$/ { body = 1 }' <<<"$resp")"
      ;;
    *) return 1 ;;
  esac
}

# subagent の Bash の timeout（600 秒）より先に返す。
deadline=$((SECONDS + 540))
fails=0
while [ "$SECONDS" -lt "$deadline" ]; do
  if fetch issue "$issue_url" && fetch inline "$inline_url"; then
    fails=0
    if [ "$(returns "$body_issue" "$body_inline" | jq '.issue + .inline | length')" -gt 0 ]; then
      echo returned
      exit 0
    fi
  else
    fails=$((fails + 1))
    if [ "$fails" -ge 6 ]; then
      echo "error: $(tail -1 "$err")"
      exit 1
    fi
  fi
  sleep 5
done
echo pending
