# LiveCue

**AI watch-and-learn copilot for TikTok LIVE creators.**

LiveCue is an AI-powered learning tool for livestreams, currently built for TikTok LIVE. It summarizes creator skills in real time while you watch, turning every LIVE room into a learning session.

LiveCue adds a learning panel to the livestream page. It uses public room signals, visible comments, livestream visuals, and page audio, then calls your own configured model/API keys to generate learnable creator skill cards.

**直播创作者的 AI 看播学习助手。**

LiveCue 是一个 AI 赋能的直播学习工具，目前支持 TikTok LIVE。它会在你观看直播时，实时总结主播的直播技巧，让每一次看播都变成一次有效学习。

LiveCue 会在直播页面侧边显示一个学习面板，基于公开直播间信号、可见评论、直播画面和音频，使用你自己配置的模型/API Key，生成可学习的主播技巧卡片。

## Download / 下载

[Download LiveCue public v1.0.0](https://github.com/summer202007/LIVECue_ai/releases/latest/download/LiveCue-public-v1.0.0.zip)

[下载 LiveCue public v1.0.0](https://github.com/summer202007/LIVECue_ai/releases/latest/download/LiveCue-public-v1.0.0.zip)

## Why LiveCue / 为什么用 LiveCue

- Watch TikTok LIVE rooms and extract creator skills in real time.
- Learn from visible comments, livestream visuals, page audio, and room interactions.
- Save useful skills into your own local learning library.
- BYOK: bring your own model/API keys. Your keys stay local.

- 观看 TikTok LIVE 时，实时提炼主播可学习的直播技巧。
- 从可见评论、直播画面、页面音频和直播间互动里学习。
- 把有价值的技巧收藏起来，沉淀自己的本地学习库。
- BYOK：使用你自己的模型/API Key，Key 保存在本地。

## See It In Action / 使用演示

**1. Works automatically on TikTok pages**  
**1. 在 TikTok 域名下自动生效**

![LiveCue works automatically on TikTok pages](docs/assets/1.gif)

**2. Start once, keep learning continuously**  
**2. 一键开启，持续学习**

![Start LiveCue once and keep learning continuously](docs/assets/2.gif)

**3. Save useful skills and build your learning library**  
**3. 支持收藏，沉淀知识库**

![Save useful skills into a learning library](docs/assets/3.gif)

**4. Configure your own API keys visually**  
**4. 可视化配置 API Key**

![Configure model and ASR API keys visually](docs/assets/1.png)

After setup, open a TikTok LIVE room, click `Start learning`, and wait about one minute. LiveCue will start showing skill cards that explain what the creator did, when it worked, and why other creators can learn from it.

完成配置后，进入一个 TikTok LIVE 直播间，点击 `Start learning`，等待大约 1 分钟。LiveCue 会开始展示技巧卡片，说明主播做了什么、什么场景下有效、为什么其他主播也能学习。

## Requirements / 使用前准备

- Chrome.
- Node.js 20 or newer. Download it from https://nodejs.org/. The local ASR relay uses Node.js.
- macOS is tested. Windows is theoretically supported with the `.bat` relay script, but not fully verified yet.
- Your own model/API keys for vision, Skill Agent, and Volcengine ASR.

- Chrome 浏览器。
- Node.js 20 或更高版本。可以从 https://nodejs.org/ 下载。本地 ASR relay 需要 Node.js。
- macOS 已测试。Windows 已提供 `.bat` relay 启动脚本，理论可用，但还没有完整实测。
- 你自己的视觉模型、Skill Agent 模型和 Volcengine ASR API Key。

## Start Here / 从这里开始

### 1. Unzip the package / 解压安装包

Unzip `LiveCue-public-v1.0.0.zip`. You should see:

解压 `LiveCue-public-v1.0.0.zip`，你会看到：

```text
LiveCue-public-v1.0.0/
  README.md
  livecue-extension/
  live-asr/
```

### 2. Install the Chrome extension / 安装 Chrome 插件

Open Chrome and go to:

打开 Chrome，进入：

```text
chrome://extensions
```

Turn on `Developer mode`.

打开 `Developer mode / 开发者模式`。

Click `Load unpacked`.

点击 `Load unpacked / 加载已解压的扩展程序`。

![Click Load unpacked in Chrome extensions](docs/assets/3.png)

Select this folder:

选择这个文件夹：

```text
LiveCue-public-v1.0.0/livecue-extension
```

![Select the livecue-extension folder](docs/assets/4.png)

### 3. Start the local ASR relay / 启动本地 ASR Relay

Open this folder:

打开这个文件夹：

```text
LiveCue-public-v1.0.0/livecue-extension
```

On macOS, double-click:

macOS 用户双击：

```text
Start LiveCue ASR Relay.command
```

On Windows, double-click:

Windows 用户双击：

```text
Start LiveCue ASR Relay.bat
```

If it works, Terminal will open and show:

如果成功，macOS 会打开 Terminal，Windows 会打开命令行窗口，并显示：

```text
LiveCue ASR relay listening on http://127.0.0.1:17395/asr
```

Keep this Terminal window open while using LiveCue.

使用 LiveCue 时，请保持这个 Terminal 窗口打开。

If macOS blocks the script, open the LiveCue Setup page, copy the fallback relay command, paste it into Terminal, choose `Start LiveCue ASR Relay.command`, and press Enter.

如果 macOS 拦截脚本，请打开 LiveCue Setup 页面，复制 fallback relay command，粘贴到 Terminal，选择 `Start LiveCue ASR Relay.command`，然后回车。

### 4. Configure API keys / 配置 API Key

After installing the extension, the LiveCue Setup page should open automatically. You can also click the Chrome extension icon to open it.

插件安装后会自动打开 LiveCue Setup 页面。你也可以点击 Chrome 插件图标打开。

Fill in:

填写：

```text
Vision model API key
Skill Agent model API key
Volcengine ASR API key
```

Then click:

然后点击：

```text
Save & run checks
```

Wait for the readiness checks to turn green.

等待红绿灯检查通过。

Success means:

成功状态是：

```text
Vision: green
Skill Agent: green
ASR helper: green
ASR key: configured
```

### 5. Start learning / 开始学习

Click:

点击：

```text
Open TikTok LIVE
```

Open a specific TikTok LIVE room.

进入一个具体的 TikTok LIVE 直播间。

The LiveCue panel will appear on the right. Click:

右侧会出现 LiveCue 面板，点击：

```text
Start learning
```

Wait for about one minute. LiveCue will start generating learnable creator skill cards.

等待大约 1 分钟，LiveCue 会开始生成可学习的主播技巧卡片。

If something does not work, open:

如果遇到问题，请先打开：

```text
docs/TROUBLESHOOTING.md
```

## What Is Included / 包含能力

- TikTok-wide LiveCue entry, with learning enabled only inside specific LIVE rooms.
- Setup page with provider configuration and readiness checks.
- OpenAI-compatible / Doubao Ark vision and chat configuration.
- Claude Skill Agent configuration.
- Volcengine ASR through a local relay.
- Skill cards, saved skill library, and debug export.

- TikTok 全站入口，但只有进入具体 LIVE 直播间才会开始学习。
- Provider 配置页和红绿灯检查。
- OpenAI-compatible / Doubao Ark 视觉与聊天模型配置。
- Claude Skill Agent 配置。
- 通过本地 relay 调用 Volcengine ASR。
- 技巧卡片、收藏库和调试导出。

## For Developers / 开发者

Useful docs:

开发者文档：

- `docs/DEVELOPMENT.md`
- `docs/ARCHITECTURE.md`
- `docs/TROUBLESHOOTING.md`
- `PRIVACY.md`
- `SECURITY.md`
- `CONTRIBUTING.md`

Build a public release zip:

构建公开发布包：

```bash
node scripts/build-release.mjs --version 1.0.0
```

Optional relay health check:

可选 relay 健康检查：

```bash
node scripts/build-release.mjs --version 1.0.0 --health-check
```

## Privacy / 隐私

LiveCue is BYOK: bring your own model/API keys. API keys are stored in local Chrome storage. The release package does not include private API keys.

LiveCue 是 BYOK 工具：使用你自己的模型/API Key。API Key 会保存在本地 Chrome storage 中。发布包不包含任何私有 API Key。

## Roadmap / 路线图

- Chrome Web Store release.
- Easier local ASR helper with less terminal setup.
- More ASR and model providers.
- Better multilingual skill cards.
- Creator learning library export.
- Mobile LIVE learning concept.

- 发布到 Chrome Web Store。
- 降低本地 ASR helper 的启动门槛，减少终端操作。
- 支持更多 ASR 和模型 provider。
- 优化多语言技巧卡片。
- 支持导出主播学习知识库。
- 探索移动端直播学习体验。

## Known Limitations / 已知限制

- Node.js is required because v1.0.0 does not include a native helper app.
- Windows support is theoretical and not fully verified yet.
- Users must bring their own model and ASR API keys.
- TikTok page changes may affect extraction quality.
- The local ASR relay terminal/command window must stay open while learning.

- 当前 v1.0.0 还没有 native helper app，因此需要 Node.js。
- Windows 当前是理论可用，还没有完整实测。
- 用户需要自己提供模型和 ASR API Key。
- TikTok 页面变化可能影响采集质量。
- 学习过程中，本地 ASR relay 的 Terminal/命令行窗口需要保持打开。
