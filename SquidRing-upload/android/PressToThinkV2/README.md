# Press to Think V2 · Android 伴侣版

版本：2.0.0。这个 APK 使用同一套 V2 对话/Agent 页面，手机原生麦克风录 16 kHz PCM，再经 Mac 本地服务调用腾讯云 ASR。输出仍走 V2 的腾讯精品 TTS 或系统备用声音。

## 当前使用方式

1. 在 Mac 启动 `press-to-think/启动 Press to Think.command`，保持终端窗口打开。
2. 用 USB 连接 Android 手机，打开开发者选项与 USB 调试。
3. 在 Mac 终端执行 `~/Library/Android/sdk/platform-tools/adb reverse tcp:3210 tcp:3210`。
4. 安装 `app/build/outputs/apk/debug/app-debug.apk`，打开应用并点「连接 V2」。
5. 在 V2 设置中开启腾讯云 ASR；安卓版目前依赖它识别手机麦克风音频。

默认地址 `http://127.0.0.1:3210/` 仅通过 USB 转发到 Mac 的本地服务；Android 模拟器也可使用 `http://10.0.2.2:3210/`。应用拒绝其他地址，避免把本地密钥服务开放到局域网或互联网。**不需要重新把密钥写进 APK。**

## 构建

用 Android Studio 打开本目录，运行 `app`；或在已安装 Android SDK/JDK/Gradle 的 Mac 上运行 `gradle assembleDebug`。不应把 `press-to-think/data/settings.json` 放进 APK。

## 明确边界

- 这是 V2 的 Android 伴侣原型，不是独立运行的正式 App：手机离开 USB/Mac 后模型服务不可用。
- 手机与电脑的浏览器存储隔离，历史会话暂不自动同步。若要跨设备同步，需要后端账户与会话存储。
- Android 原生收音 + 腾讯云 ASR 已接入；网页的原始录音回放在安卓版暂不可用。
- 真正的戒指 BLE 按钮和戒指麦克风尚未接入，当前用屏幕红色按钮验证交互。
- 上架前需要账户鉴权、密钥托管、HTTPS 服务、隐私合规及硬件联调。
