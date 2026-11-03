#!/bin/bash
# Unit tests, build, smoke / layout / node checks, then packaging. One summary: <logdir>/all.log
# usage: bash scripts/all.sh <logdir> [--no-pack]
cd "$(dirname "$0")/.."
L=${1:-/tmp/psd-all}
mkdir -p "$L"
T="/f/.幻之图集/模板"
E=node_modules/electron/dist/electron.exe
{ timeout 60 node test/run.mjs | tail -3
  npm run build 2>&1 | tail -1
  timeout 300 $E test/smoke.cjs "$T/影子牌捆绑_QQ_2407187481_HEX_000CCBBD.psd" "$T/奈牌涩涩.psd" "$T/79 我摸摸全配.ipv" 2>&1 | grep -oE '^(ok|FAIL) +[^ ]+|"suggest":\{[^}]*\}|"exact":"[^"]*"|"searchKeepsFocus":[a-z]+|"eyeOption":\{[^}]*\}|all files passed|failed'
  timeout 150 $E test/layout.cjs "$T/影子牌捆绑_QQ_2407187481_HEX_000CCBBD.psd" "$L/layout" 390 2>&1 | grep -E "^(OVER|GEST)|layout ok|overflow"
  timeout 240 $E test/nodes.cjs "$T/影子牌捆绑_QQ_2407187481_HEX_000CCBBD.psd" "$L/nodes" 2>&1 | grep -E "^(ok|FAIL)" | grep -oE "^(ok|FAIL) +[0-9]+px|\"[a-zA-Z]+\":false|maxEdgeError.:[0-9.]+"
} > "$L/all.log" 2>&1
[ "$2" = "--no-pack" ] && exit 0
bash scripts/pack.sh "$L"
cat "$L/pack.log" >> "$L/all.log"
ls -la release/*$(node -p "require('./package.json').version")* >> "$L/all.log" 2>&1
