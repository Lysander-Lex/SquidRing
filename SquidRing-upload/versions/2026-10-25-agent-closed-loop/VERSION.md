# SquidRing Agent 闭环版本

版本目录：`versions/2026-10-25-agent-closed-loop/`

这是 2026-10-25 实测通过的 Agent 联调版本快照。原仓库中的 `android/`、`press-to-think/`、`press-to-think-hardware/` 和网站工程保留不变，本目录用于保存当前可运行版本，便于回溯和演示。

## 已验证闭环

戒指按键与麦克风收音 → BLE 传输到 Android → 腾讯云 ASR → Mac 本地 Node 后端 → OpenClaw Agent 实际调用工具 → 返回文件结果或路径 → App 展示摘要。

已用真实语音任务验证 Agent 创建文件并返回结果。

## 目录

- `android/PressToThinkV2/`：Android 伴侣应用、原生 BLE/录音/会话服务和联调脚本。
- `press-to-think/`：Node 本地后端、ASR/TTS、摘要和 OpenClaw 网关适配。

## 联调准备

在 Mac 上启动 Android 联调脚本：

```bash
cd android/PressToThinkV2
bash ./debug-mac.sh --start-backend --serial YOUR_ANDROID_SERIAL
```

脚本会检查或启动 3210 后端，等待 health 接口可用，重建 USB 反向转发，然后安装并启动 App。

后端需要通过环境变量提供 OpenClaw 配置：

```bash
OPENCLAW_BASE_URL="http://OPENCLAW_HOST:18789" \
OPENCLAW_TOKEN="从本机安全环境提供" \
SETTINGS_PATH="本机模型与腾讯配置文件路径" \
npm start
```

令牌、模型密钥、`data/settings.json`、APK 和运行日志不进入 Git。

## 验证

Node 后端：

```bash
node --check press-to-think/server.mjs
node press-to-think/tests/remote-access.mjs
node press-to-think/tests/integration.mjs
```

Android：

```bash
./android/PressToThinkV2/gradlew -p android/PressToThinkV2 assembleDebug lintDebug
```

## Gradle Wrapper 文本上传与恢复

由于 GitHub 文本上传接口不能直接传输二进制，`android/PressToThinkV2/gradle/wrapper/gradle-wrapper.jar` 以标准 Base64 无损保存在同目录的 `gradle-wrapper.jar.base64` 中。本地原始 JAR 保留不变。

构建脚本会在 JAR 缺失时自动恢复：`gradlew` 优先使用 `base64 -d`，并兼容 macOS 的 `base64 -D`；`gradlew.bat` 使用 PowerShell 内联 `[Convert]::FromBase64String`。JAR 已存在时直接使用现有文件。

原始及恢复后 JAR 的 SHA256：

```text
76805e32c009c0cf0dd5d206bddc9fb22ea42e84db904b764f3047de095493f3
```

## 当前边界

该快照适合黑客松 Demo 和核心 Agent 演示。它仍依赖 Mac 本地后端与 USB 反向转发；长期 Doze、断网恢复、复杂多步任务、HTTPS 远程部署和脱离 Mac 运行尚未完成正式验收。
