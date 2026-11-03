#!/bin/bash
# Build the Windows installers + portable EXE and the Android APK into release/.
# usage: bash scripts/pack.sh <logdir>
cd "$(dirname "$0")/.."
L=${1:-.}
mkdir -p "$L"
VER=$(node -p "require('./package.json').version")
{ npx electron-builder --win --x64 2>&1; echo "EXE exit=$?"; } > "$L/pack-exe.log"
( npx cap sync android 2>&1 && cd android && JAVA_HOME="/c/Program Files/Java/jdk-21" ./gradlew.bat assembleDebug -q 2>&1; echo "APK exit=$?" ) > "$L/pack-apk.log"
APK=android/app/build/outputs/apk/debug/app-debug.apk
[ -f $APK ] && cp $APK "release/PSD-Combo-Exporter-$VER-android.apk"
cat "$L/pack-exe.log" "$L/pack-apk.log" | grep -E "exit=|target=" > "$L/pack.log"
