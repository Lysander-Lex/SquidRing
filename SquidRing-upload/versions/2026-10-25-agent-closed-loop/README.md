# SquidRing / Press to Think

现有 AI 戒指产品原型代码。软件原型版本为 V2；戒指固件和外壳仍在独立验证中。

## 目录

- `press-to-think/`：本地对话服务与网页原型。
- `android/PressToThinkV2/`：Android 伴侣应用，目前通过 USB 连接本地服务。
- `press-to-think-site/`：独立的网站部署工程。
- `press-to-think-hardware/`：戒指按键固件和 CAD 源文件。

## 本地运行

在 `press-to-think/` 下运行 `npm start`，打开 `http://localhost:3210`。首次使用需在本地设置自己的模型与语音服务密钥。详细步骤见该目录的 README。

## 当前边界

真实戒指的蓝牙联动及戒指麦克风尚未接入。Android 版依赖 Mac 上的本地服务，不是脱离电脑运行的正式版。仓库不包含个人密钥、运行时设置或构建产物。
