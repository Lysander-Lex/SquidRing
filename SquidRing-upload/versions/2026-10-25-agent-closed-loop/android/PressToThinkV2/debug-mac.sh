#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'EOF'
用法：bash debug-mac.sh [--build] [--serial SERIAL] [--help]

默认使用脚本所在工程的 app/build/outputs/apk/debug/app-debug.apk。
  --build          先执行工程 gradlew -p 工程根 assembleDebug lintDebug。
  --start-backend  后端未运行时自动启动本地 Node 后端，并等待 health 可用。
  --serial SERIAL  指定设备序列号，优先于 ANDROID_SERIAL。
  -h, --help       显示帮助后退出，不检查环境、不运行 ADB 或构建。

未指定设备时，仅在 adb devices -l 中恰好一个状态为 device 的设备时自动选择；
否则列出设备并退出。安装前执行选中设备的 get-state，随后依次执行：
  install -r、reverse tcp:3210 tcp:3210、shell am start。

环境：
  SDK 按 ANDROID_HOME、ANDROID_SDK_ROOT、$HOME/Library/Android/sdk 的顺序选择。
  ADB 可设为单个可执行文件的路径或命令名，默认使用所选 SDK 的 platform-tools/adb。
  JAVA_HOME 未设置时尝试 /Applications 或 $HOME/Applications 下 Android Studio 的 JBR。
  仅 --build 要求可用的 SDK 和 Java；已有 APK 可通过 ADB 覆盖直接安装。

脚本可从任意工作目录调用，不修改应用偏好；默认不自动启动后端，使用 --start-backend 可在本机联调时自动确保后端可用。
最后用 curl 检查 http://127.0.0.1:3210/api/health，只报告本机服务是否可用；
模型、ASR 和 TTS 供应商连通性未验证，health 失败仅提示，不撤销安装。
请在 APK「设置」确认后端地址为 http://127.0.0.1:3210，点击「保存并确认」后再点「检查服务配置」。
EOF
}

die() {
    printf '错误：%s\n' "$*" >&2
    exit 1
}

build=0
start_backend=0
serial="${ANDROID_SERIAL:-}"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --build)
            build=1
            shift
            ;;
        --start-backend)
            start_backend=1
            shift
            ;;
        --serial)
            [[ $# -ge 2 && -n "$2" && "$2" != -* ]] || die '--serial 后需要设备序列号；使用 --help 查看用法。'
            serial="$2"
            shift 2
            ;;
        --serial=*)
            serial="${1#*=}"
            [[ -n "$serial" && "$serial" != -* ]] || die '--serial 需要非空设备序列号。'
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            die "未知参数：$1；使用 --help 查看用法。"
            ;;
    esac
done

ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(CDPATH= cd -- "$ROOT/../.." && pwd -P)"
BACKEND_ROOT="$PROJECT_ROOT/press-to-think"
APK="$ROOT/app/build/outputs/apk/debug/app-debug.apk"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"

if [[ -z "${JAVA_HOME:-}" ]]; then
    for jbr in "/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
               "$HOME/Applications/Android Studio.app/Contents/jbr/Contents/Home"; do
        if [[ -x "$jbr/bin/java" ]]; then
            export JAVA_HOME="$jbr"
            break
        fi
    done
fi

if [[ "$build" -eq 1 ]]; then
    [[ -d "$SDK" ]] || die "找不到 Android SDK：$SDK；请安装 SDK Platform 36 和兼容的 Build Tools，并设置 ANDROID_HOME 或 ANDROID_SDK_ROOT。"
    [[ -n "${JAVA_HOME:-}" && -x "${JAVA_HOME:-}/bin/java" ]] || die '找不到可用的 Java；请安装 Android Studio，或将 JAVA_HOME 指向 JDK 21 / Android Studio JBR。'
    "$ROOT/gradlew" -p "$ROOT" assembleDebug lintDebug
fi

[[ -f "$APK" ]] || die "未找到调试 APK：$APK；请运行 bash \"$ROOT/debug-mac.sh\" --build，或先执行 \"$ROOT/gradlew\" -p \"$ROOT\" assembleDebug lintDebug 后重试。"

adb_command="${ADB:-$SDK/platform-tools/adb}"
adb_bin="$(command -v "$adb_command")" || die "找不到 ADB：$adb_command；请通过 Android Studio SDK Manager 安装 Android SDK Platform-Tools，或设置 ADB 为 adb 可执行文件路径。"
[[ -x "$adb_bin" && ! -d "$adb_bin" ]] || die "ADB 不是可执行文件：$adb_bin；ADB 只接受单个命令名或文件路径。"

if [[ -z "$serial" ]]; then
    device_list="$("$adb_bin" devices -l)" || die '无法列出 ADB 设备；请检查 Platform-Tools 和 USB 连接。'
    device_count=0
    candidate=''
    while IFS=$' \t\r' read -r listed_serial state rest; do
        if [[ "$state" == 'device' ]]; then
            device_count=$((device_count + 1))
            candidate="$listed_serial"
        fi
    done <<< "$device_list"
    if [[ "$device_count" -ne 1 ]]; then
        printf '%s\n' "$device_list" >&2
        die "发现 $device_count 个状态为 device 的设备，拒绝猜测目标；请连接并解锁手机、启用 USB 调试并确认授权，再用 --serial SERIAL 或 ANDROID_SERIAL 明确选择设备。"
    fi
    serial="$candidate"
fi

adb_target=("$adb_bin" -s "$serial")
if ! device_state="$("${adb_target[@]}" get-state)" || [[ "$device_state" != 'device' ]]; then
    "$adb_bin" devices -l >&2 || true
    die "设备 $serial 未就绪（需要状态 device）；请检查序列号、USB 调试授权及 offline/unauthorized 状态后重试。"
fi

printf '使用设备：%s\n' "$serial"

if [[ "$start_backend" -eq 1 ]]; then
    backend_health=''
    if command -v curl >/dev/null 2>&1; then
        backend_health="$(curl --disable --noproxy '*' --silent --show-error --connect-timeout 1 --max-time 3 --output /dev/null --write-out '%{http_code}' 'http://127.0.0.1:3210/api/health' || true)"
    fi
    if [[ "$backend_health" != '200' ]]; then
        [[ -d "$BACKEND_ROOT" ]] || die "找不到后端目录：$BACKEND_ROOT"
        backend_log="$BACKEND_ROOT/.debug-backend.log"
        (cd "$BACKEND_ROOT" && SETTINGS_PATH="${SETTINGS_PATH:-$HOME/.codex/.chatgpt-projects/鱿鱼戒指/press-to-think/data/settings.json}" npm start >>"$backend_log" 2>&1) &
        backend_pid=$!
        for attempt in {1..30}; do
            if curl --disable --noproxy '*' --silent --show-error --fail --connect-timeout 1 --max-time 2 'http://127.0.0.1:3210/api/health' >/dev/null 2>&1; then
                backend_health='200'; break
            fi
            kill -0 "$backend_pid" 2>/dev/null || die "后端提前退出，请查看日志：$backend_log"
            sleep 1
        done
        [[ "$backend_health" == '200' ]] || die "后端启动超时，请查看日志：$backend_log"
        printf '已启动本地后端（PID %s）。\n' "$backend_pid"
    else
        printf '%s\n' '本地后端已在运行。'
    fi
fi

"${adb_target[@]}" install -r "$APK"
"${adb_target[@]}" reverse --remove tcp:3210 >/dev/null 2>&1 || true
"${adb_target[@]}" reverse tcp:3210 tcp:3210
"${adb_target[@]}" shell am start -W -n com.presstothink.v2/.MainActivity
printf '%s\n' '已完成 APK 安装、端口转发和启动命令。'

if command -v curl >/dev/null 2>&1; then
    if health_code="$(curl --disable --noproxy '*' --silent --show-error --fail \
        --connect-timeout 2 --max-time 5 --output /dev/null --write-out '%{http_code}' \
        'http://127.0.0.1:3210/api/health')" && [[ "$health_code" == '200' ]]; then
        printf '%s\n' '本机服务可用（health HTTP 200）；模型、ASR 和 TTS 供应商连通性未验证。'
    else
        printf '未确认本机服务可用（health HTTP %s）；请在工程 ../../press-to-think 中手动运行 npm start 后重试。\n' "$health_code" >&2
        printf '%s\n' '此结果仅针对本机 health 端点，未验证模型、ASR 或 TTS 供应商连通性。' >&2
    fi
else
    printf '%s\n' '未找到 curl，已跳过本机 health 检查；请安装 curl 后重试。本机服务和供应商连通性均未验证。' >&2
fi

printf '%s\n' '请手动在 APK「设置」将后端地址设为 http://127.0.0.1:3210，点击「保存并确认」，再点「检查服务配置」。'
