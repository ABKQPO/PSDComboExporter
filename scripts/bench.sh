#!/bin/bash
# Export throughput for several worker setups. usage: bash scripts/bench.sh <logdir> "WK=1 ENC=1" "DESK=1" ...
cd "$(dirname "$0")/.."
L=$1; shift
mkdir -p "$L"
F="/f/.幻之图集/模板/影子牌捆绑_QQ_2407187481_HEX_000CCBBD.psd"
for cfg in "$@"; do
  echo "== $cfg"
  env $cfg timeout 300 node_modules/electron/dist/electron.exe test/exportbench.cjs "$F" 2>&1 | grep -oE '"zip20":\{[^}]*\}|"slots":[0-9]+|"workers":[0-9]+|"identical":[0-9]+|"perImage":\{[^}]*\}|TIMEOUT'
done > "$L/bench.log" 2>&1
