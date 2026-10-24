# 鱿鱼戒指 Android 调试

## 环境

- Android Studio，安装 Android SDK Platform 36、兼容的 Build Tools 和 Android SDK Platform-Tools（提供 `adb`）。手动构建时可通过本机 `local.properties` 指向 Android SDK；若已有该文件，请确认其 `sdk.dir` 与实际使用的 SDK 一致。
- JDK 21（可使用 Android Studio 自带 JBR）。
- Node.js 18 或更新版本用于电脑端语音与模型后端。
- USB 调试已启用的 Android 手机；戒指已有 PressToThink Ring Audio 音频固件。
- 后端的模型、腾讯 ASR/TTS 凭证由电脑后端持有，不要写入 APK 或提交到仓库。

## Mac 调试脚本

在本工程目录使用 Bash 运行（兼容 macOS 自带 Bash）：

```sh
# 查看帮助，不触发环境检查、ADB 或构建
bash ./debug-mac.sh --help

# 使用已有 APK，仅在恰好一个设备处于 device 状态时自动选择
bash ./debug-mac.sh

# 先构建并运行 lint，再安装到指定设备
bash ./debug-mac.sh --build --serial YOUR_DEVICE_SERIAL

# 也可通过环境变量选择设备；--serial 优先
ANDROID_SERIAL=YOUR_DEVICE_SERIAL bash ./debug-mac.sh
```

脚本从自身位置确定工程根，可在任意工作目录通过脚本完整路径调用。`--build` 执行 `"$ROOT/gradlew" -p "$ROOT" assembleDebug lintDebug`；不传 `--build` 时只使用现有 `app/build/outputs/apk/debug/app-debug.apk`，缺失就报错并提示构建命令。脚本不自动安装 SDK 或修改 `local.properties`；首次 `--build` 可能由 Gradle Wrapper 下载 Gradle。

SDK 依次选择非空的 `ANDROID_HOME`、`ANDROID_SDK_ROOT`、`$HOME/Library/Android/sdk`，并在脚本进程内将两个 SDK 环境变量统一为选定路径；显式路径无效时请修正配置。`ADB` 可覆盖为单个可执行文件路径或 PATH 中的命令名，不支持附带参数；默认使用所选 SDK 的 `platform-tools/adb`。例如：

```sh
ANDROID_HOME="$HOME/Library/Android/sdk" bash ./debug-mac.sh --build --serial YOUR_DEVICE_SERIAL
ADB="$HOME/Library/Android/sdk/platform-tools/adb" bash ./debug-mac.sh --serial YOUR_DEVICE_SERIAL
```

已有 `JAVA_HOME` 会保留；缺失或为空时，依次尝试 `/Applications/Android Studio.app/Contents/jbr/Contents/Home` 和 `$HOME/Applications/Android Studio.app/Contents/jbr/Contents/Home`。`--build` 要求可用的 SDK 与 Java；只安装已有 APK 时可通过 `ADB` 覆盖而无需本机 SDK/JDK。

选设备时，`--serial` 优先于 `ANDROID_SERIAL`；两者都未指定时，只统计 `adb devices -l` 中状态恰为 `device` 的设备。数量为零或大于一会列出设备并退出，不猜测目标。`unauthorized` 时请在手机上确认 USB 调试授权，`offline` 时请检查连接。选定后，脚本先执行 `adb -s SERIAL get-state` 并要求结果为 `device`，才依次执行：

```sh
adb -s YOUR_DEVICE_SERIAL install -r app/build/outputs/apk/debug/app-debug.apk
adb -s YOUR_DEVICE_SERIAL reverse tcp:3210 tcp:3210
adb -s YOUR_DEVICE_SERIAL shell am start -W -n com.presstothink.v2/.MainActivity
```

最后使用 `curl` 请求本机 `http://127.0.0.1:3210/api/health`，绕过代理、忽略 curl 配置文件、不跟随重定向且丢弃响应体，仅在 HTTP 200 时报告本机服务可用。失败或缺少 curl 会给出提示，不撤销安装，也不自动启动后端。health 结果不能证明手机到后端已通，不能证明 AI 模型、ASR 或 TTS 供应商连通。脚本不读取服务密钥、不修改应用偏好；后端地址与令牌需在 APK 中手动保存。

只做脚本语法和帮助检查、避免构建或访问设备时：

```sh
bash -n ./debug-mac.sh
bash ./debug-mac.sh --help
```

## 手动构建 APK

macOS（在本工程目录）：

```sh
./gradlew assembleDebug lintDebug
```

调试 APK：

```text
app/build/outputs/apk/debug/app-debug.apk
```

安装：

```sh
adb -s YOUR_DEVICE_SERIAL install -r app/build/outputs/apk/debug/app-debug.apk
```

Android Studio 打开当前工程时，连接 USB 手机并从 Android Studio 运行 `app` 也可构建、安装和查看 Logcat。首次使用 Gradle Wrapper 需要联网下载 Gradle 9.1.0；Android Studio 也可使用已安装的 Gradle。

## Mac 电脑后端调试

从本 Android 工程目录启动原 Node 服务：

```sh
cd ../../press-to-think
npm start
```

后端默认只监听电脑回环地址 `127.0.0.1:3210`，需要手动启动；调试脚本不会代为启动。手机 USB 接入后，脚本会配置反向转发；手动配置时请明确设备：

```sh
adb -s YOUR_DEVICE_SERIAL reverse tcp:3210 tcp:3210
```

在 APK 底部「设置」打开「戒指与服务」，将「后端地址」填为 `http://127.0.0.1:3210`，点击「保存并确认」后，再打开设置点击「检查服务配置」。检查使用已保存的配置，未保存的输入不会生效；此检查不要求先连接戒指。Android 模拟器也可通过 `adb reverse` 连接电脑回环地址。

后端默认从其本地 `data/settings.json` 读取模型、腾讯 ASR 与 TTS 凭证（可由 `SETTINGS_PATH` 指定文件）；首次联调时请在电脑浏览器打开 `http://127.0.0.1:3210` 的设置页并保存。应用访问令牌在远程模式或后端显式配置了 `APP_ACCESS_TOKEN` 时填写；普通本机调试不需要令牌。

本次开发发现原工程已保存可用凭证，当前调试服务通过下列路径读取原配置，未复制密钥到新仓库或 APK。需要重启时，在后端目录执行：

```sh
SETTINGS_PATH="$HOME/.codex/.chatgpt-projects/鱿鱼戒指/press-to-think/data/settings.json" npm start
```

已用该配置验证真实模型返回、腾讯 TTS 音频返回和腾讯 ASR 非空文本。ASR 以合成测试语音转为 16 kHz PCM 验证，不能替代戒指麦克风与 BLE 实测。实时 ASR 按音频实际时长发送，90 秒录音还需约 90 秒上传识别；后续应根据体验决定是否改为边录边传。

APK 中「检查服务配置」通过 `/api/status` 查看模型配置、ASR 和腾讯 TTS 的启用及凭证存在状态；状态接口不可用时可能回退到 `/api/health`，此时各服务显示「状态未知」，令牌缺失或无效则提示令牌问题。该检查不会发起真实模型调用或腾讯云计费请求；「已配置／已启用」和后端可访问均不代表供应商已连通。

## 戒指配对

在「设置」填写电脑或手机 BLE 权限允许的戒指地址，或使用系统关联选择器关联广播服务为 `Ring Audio` 的戒指。先保持 APK 前台连接成功，再锁屏测试。录音输入始终来自 XIAO 麦克风，不使用手机麦克风。

BLE 地址留空时，首次发现多个戒指会要求填写指定地址。Android 14 模拟器没有蓝牙验证能力。

## 远程后端

远程模式必须配置至少 32 字符的 `APP_ACCESS_TOKEN`。服务绑定非 loopback 地址时会自动启用远程模式；若 HTTPS 反向代理将请求转发到仍监听 loopback 的 Node 服务，必须显式设置 `REMOTE_MODE=1`，不能仅凭存在反向代理判断为远程模式。例如在后端目录启动：

```sh
REMOTE_MODE=1 HOST=127.0.0.1 APP_ACCESS_TOKEN='<至少32字符随机令牌>' npm start
```

此时 HTTPS 反向代理的上游为 `http://127.0.0.1:3210`。手机「后端地址」填写最终的 `https://` 地址，「应用访问令牌」填写同一令牌，并点击「保存并确认」后再「检查服务配置」。远程模式不开放 `/api/settings`，模型与腾讯密钥必须在服务端文件或安全的服务器配置中管理。不要使用明文 HTTP 暴露公网服务。本机 `adb reverse` 调试脚本仍只检查 Mac 的 loopback health，不验证远程 HTTPS 代理或供应商连通性。

## 调试工具与验证范围

- 网页调试：Debug APK 启用 WebView DevTools，桌面 Chrome 可在 `chrome://inspect/#devices` 检查。
- 后台日志：`adb logcat -s SquidRing`。
- 伴侣设备关联：部分手机不提供系统关联服务；这些机型仍可用 Android 前台设备服务与厂商后台设置运行。
- 屏幕关闭、长时间待机、断网恢复、锁屏 TTS、真实 BLE 丢包和多厂商省电行为，必须在实际 Android 手机上验证。系统强行停止应用后不能保证自动恢复。
- 本工程未内置 Android SDK/JDK，也未提交机器专属的 `local.properties`；标准构建需要本机 Android Studio/SDK 和 JDK。
