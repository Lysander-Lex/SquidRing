# 鱿鱼戒指 Android · 3.0.0-dev

本工程为兼容现有 XIAO nRF52840 Sense 音频固件的安卓开发版，Android 8.0（API 26）起可安装，targetSdk 35。界面沿用原产品的米色／红色风格，已移除首页戒指音频调试面板，连接与系统关联入口位于设置。

## 已实现

- 原生 BLE 接收戒指 16 kHz G.711 μ-law 音频，解码为 PCM16；不申请或使用手机麦克风。
- 原生前台服务承接长按录音、松开发送、短按双击摘要播放、长按打断、会话与历史恢复。
- 原生模型调用、语音识别、纠错、指令解析、快速／深度模式及摘要；WAV 与会话保存在应用私有目录。
- 腾讯 TTS 与系统中文 TTS 回退、音频焦点、MediaSession 和播放前台服务。
- 系统伴侣设备关联、断链重连、临时关联取消后的恢复，以及锁屏工作所需的唤醒锁管理。
- HTTPS 后端地址与应用访问令牌；供应商长期密钥只由 Node 后端持有。

## Mac 调试

详细构建、配置、安装步骤见 [DEBUGGING.md](DEBUGGING.md)。在本目录执行：

```sh
bash ./debug-mac.sh --help
bash ./debug-mac.sh --serial YOUR_DEVICE_SERIAL
# 需要先构建时：
bash ./debug-mac.sh --build --serial YOUR_DEVICE_SERIAL
```

默认 APK 为 `app/build/outputs/apk/debug/app-debug.apk`。通过 `adb reverse tcp:3210 tcp:3210` 连接 Mac 后端；在应用设置保存 `http://127.0.0.1:3210` 后点击「检查服务配置」。远程运行需要另外部署 HTTPS 后端并填入访问令牌。

## 验证状态与边界

2026-10-24：APK 编译、签名核验通过，Lint 为 0 errors / 4 warnings；μ-law 协议测试、后端接口与鉴权回归、Android 14 模拟器原生链路及 WebView 渲染／诊断／播放服务生命周期检查通过。Mac 安装调试脚本已在模拟器执行通过。

使用原工程已有配置，真实模型返回、腾讯 TTS 音频和腾讯 ASR 非空文本均已验证。ASR 测试输入为合成语音转换的 PCM，专有词出现同音误识别；后端已修复实时识别字段解析并按实时率上传。此结果不代表真实戒指收音准确率。

尚未完成：安卓真机 BLE、双击时序、长时间锁屏与 Doze、耳机与来电、厂商省电、断网恢复、HTTPS 云部署和脱离 Mac 使用。未烧录或修改现有戒指固件，未推送远端仓库。本 APK 为 Debug 签名开发版，不是完成正式验收的发布版。用户强行停止应用后不能保证自动恢复。

首次构建的 Gradle Wrapper 联网下载未验证成功；本次使用本机缓存的 Gradle 9.1.0 构建。历史只保存在当前手机，不含账户或跨设备同步；外部任务执行与独立长录音纪要未接入。
