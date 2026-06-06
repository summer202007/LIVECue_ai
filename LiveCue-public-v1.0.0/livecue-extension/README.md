# LiveCue Public v1.0.0

LiveCue is a Chrome extension for learning from TikTok LIVE rooms. It collects public room signals, visible comments, livestream frames, and page audio, then calls user-configured model providers to generate learnable creator skill cards.

LiveCue 是一个用于 TikTok LIVE 看播学习的 Chrome 插件。它会采集公开直播间信号、可见评论、直播画面和页面音频，并调用用户自己配置的模型，生成可学习的主播技巧卡片。

## What Is Included / 包含能力

- TikTok-wide LiveCue entry, with learning enabled only inside specific LIVE rooms.
- Setup page with provider configuration and readiness checks.
- OpenAI-compatible / Doubao Ark vision and chat configuration.
- Claude Skill Agent configuration.
- Volcengine ASR through a local relay.
- Local ASR relay scripts: `Start LiveCue ASR Relay.command` for macOS and `Start LiveCue ASR Relay.bat` for Windows.
- Skill cards, saved skill library, and debug export.

- TikTok 全站入口，但只有进入具体 LIVE 直播间才会开始学习。
- Provider 配置页和红绿灯检查。
- OpenAI-compatible / Doubao Ark 视觉与聊天模型配置。
- Claude Skill Agent 配置。
- 通过本地 relay 调用 Volcengine ASR。
- 本地 ASR relay 启动脚本：macOS 使用 `Start LiveCue ASR Relay.command`，Windows 使用 `Start LiveCue ASR Relay.bat`。
- 技巧卡片、收藏库和调试导出。

## Install / 安装

See the top-level `README.md` in the release package.

请阅读 release 包一级目录里的 `README.md`。

## Privacy / 隐私

API keys are stored in local Chrome storage. LiveCue does not include private API keys in the release package.

API Key 会保存在本地 Chrome storage 中。发布包不包含任何私有 API Key。
