# 鱿鱼戒指 · Agent 闭环版本

这是鱿鱼戒指在 **2026-10-25 完成真实语音 Agent 任务联调**后保存的源码快照。戒指通过蓝牙连接 Android 手机，用户按住戒指说出任务，由手机和后端交给 OpenClaw 执行，再将结果返回 App。

本目录独立保存这一阶段的代码，原有版本目录保留。本快照仍使用 Mac 本地后端与 USB 转发；HTTPS 远程部署尚未完成。目录名、工程名与应用内部版本号不代表正式产品发布版本。

## 已跑通的功能

- **戒指语音输入**：使用戒指麦克风收音，通过 BLE 向手机传输音频；不使用手机麦克风作为替代输入。
- **Android 伴侣 App**：戒指连接、连续多轮对话、会话历史、摘要及语音播放；多轮与熄屏使用已有现场验证。
- **语音处理后端**：对接腾讯云 ASR/TTS、文本纠错、对话与摘要服务。
- **OpenClaw 任务执行**：主任务通过远程 Agent 接口执行，辅助纠错与摘要使用原有模型链路。
- **真实端到端验证**：已通过戒指语音发出创建文件任务，Agent 返回执行结果，用户在 App 端确认成功。

一次成功任务验证了核心演示链路，不代表所有复杂任务或长期后台场景均已验收。

## 工作链路

```text
戒指按住说话、松开发送
  → BLE 音频传输
  → Android App
  → USB 端口转发
  → Mac Node 后端（3210）
  → 腾讯云 ASR / 文本处理
  → OpenClaw Agent 调用工具执行任务
  → 结果返回 App / 生成摘要 / 按需语音播放
```

**当前完整 AI 功能仍需手机通过 USB 连接 Mac，且 Mac 后端保持运行并能访问网络。** 戒指蓝牙已连接，并不代表后端或 Agent 一定可达。

## 本目录内容

```text
.
├── android/PressToThinkV2/   # Android 原生服务、BLE、会话、界面与测试
├── press-to-think/          # Node 后端、网页资源与后端测试
├── README.md               # 当前版本使用入口
└── VERSION.md              # 版本记录、验证范围与构建说明
```

本快照不含独立网站部署工程、戒指固件或 CAD 文件；这些材料需到仓库其他目录查看。戒指联调沿用已有音频固件，本轮未烧录新固件。

## 本地构建与联调

以下命令均以**当前版本目录**为起点。需要 Node.js/npm、Android SDK、兼容工程的 JDK 与 Gradle 环境；手机需启用 USB 调试并完成电脑授权。Android 环境细节见 [Android 说明](android/PressToThinkV2/README.md) 与 [Mac 调试说明](android/PressToThinkV2/DEBUGGING.md)。

### 1. 准备服务配置并启动后端

仓库不包含可直接使用的个人服务密钥。先准备本机模型、腾讯云语音配置，并在终端环境中设置：

- `SETTINGS_PATH`：本机服务配置 JSON 的绝对路径。
- `OPENCLAW_BASE_URL`：可访问的 OpenClaw 网关地址。
- `OPENCLAW_TOKEN`：对应网关的访问令牌。

配置文件格式和本地设置方式见 [后端说明](press-to-think/README.md)。配置好环境变量后运行：

```bash
(cd press-to-think && npm start)
```

另开终端检查服务是否启动：

```bash
curl http://127.0.0.1:3210/api/health
```

health 成功仅代表本地 HTTP 服务存活，不证明模型、ASR、TTS 或 Agent 均可用。未配置 OpenClaw 时，后端可走普通模型回答，不能据此认定 Agent 工具执行已接入。

### 2. 构建 Android APK

```bash
bash android/PressToThinkV2/gradlew \
  -p android/PressToThinkV2 assembleDebug lintDebug
```

APK 输出位置：

```text
android/PressToThinkV2/app/build/outputs/apk/debug/app-debug.apk
```

GitHub 快照中的 Gradle Wrapper JAR 以 `gradle-wrapper.jar.base64` 无损保存，构建脚本会在 JAR 缺失时自动还原。首次构建可能需要联网下载 Gradle 和依赖；更多说明见 [VERSION.md](VERSION.md)。

### 3. 安装、建立 USB 转发并启动 App

保持后端终端运行，手机通过 USB 接入 Mac 后执行：

```bash
bash android/PressToThinkV2/debug-mac.sh --serial YOUR_ANDROID_SERIAL
```

脚本会安装已构建的 APK、重建 `3210` USB 反向转发并启动 App。在 App 设置中保存后端地址：

```text
http://127.0.0.1:3210
```

然后检查服务配置并连接戒指。手机重新插拔后可能需要重新建立 USB 转发。

脚本也支持 `--build` 先构建，以及 `--start-backend` 在本地服务未运行时尝试启动后端；后者需继承上述服务配置环境变量，不会自动提供密钥。

## 测试与当前边界

后端回归命令：

```bash
node --check press-to-think/server.mjs
node press-to-think/tests/remote-access.mjs
node press-to-think/tests/integration.mjs
```

这些检查在本阶段联调中已通过，真实语音文件任务也已由用户现场确认成功。仍待专项验证或开发的内容包括：

- 长时间锁屏、Doze、省电和来电等场景下的稳定性。
- 断网、后端中断与手机重新连接后的完整恢复能力。
- 连续复杂任务和多步骤 Agent 执行的可靠性。
- HTTPS 远程部署及脱离 Mac/USB 的随身使用。
- 戒指离线保存多段录音并在重连后补传。

Agent 返回的完成声明、文件路径或完成标记，属于 Agent 回报，不能替代对目标系统的独立核验；服务器上的文件也不会自动出现在 Mac 本地。

## 配置与数据

本快照不包含供应商密钥、OpenClaw 令牌、运行时 `settings.json`、用户会话与音频、日志或 APK。使用时需自行配置服务，勿将这些运行数据提交到仓库。
