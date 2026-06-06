# Troubleshooting / 常见问题

## The ASR helper is red / ASR helper 是红灯

What it means:

这通常表示：

The local ASR relay is not running.

本地 ASR relay 没有启动。

Try:

可以这样做：

1. Open `livecue-extension`.
2. macOS: double-click `Start LiveCue ASR Relay.command`.
3. Windows: double-click `Start LiveCue ASR Relay.bat`.
4. Keep the Terminal / command prompt window open.
5. Go back to LiveCue Setup and click `Save & run checks`.

## The relay window says `node is not recognized` / relay 窗口提示找不到 node

What it means:

这通常表示：

Node.js is not installed, or it is not available in your system PATH.

你的电脑没有安装 Node.js，或者系统 PATH 里找不到 Node.js。

Try:

可以这样做：

1. Install Node.js 20 or newer from https://nodejs.org/.
2. Close and reopen Terminal / Command Prompt.
3. Run `node -v`.
4. Double-click the LiveCue relay script again.

1. 从 https://nodejs.org/ 安装 Node.js 20 或更高版本。
2. 关闭并重新打开 Terminal / 命令提示符。
3. 运行 `node -v`。
4. 再次双击 LiveCue relay 启动脚本。

## Windows opens the relay window and then closes / Windows 启动窗口一闪而过

What it means:

这通常表示：

The relay script hit an error before it could stay running.

relay 脚本启动时遇到了错误。

Try:

可以这样做：

1. Open `livecue-extension`.
2. Right-click `Start LiveCue ASR Relay.bat`.
3. Choose `Open` or run it from Command Prompt.
4. Read the message shown in the command window.
5. If it says Node is missing, install Node.js 20 or newer.

## The relay says port 17395 is already in use / relay 提示 17395 端口被占用

What it means:

这通常表示：

Another LiveCue relay window is already running, or another app is using the same local port.

已经有一个 LiveCue relay 窗口在运行，或者其他程序占用了同一个本地端口。

Try:

可以这样做：

1. Close other LiveCue relay Terminal / command prompt windows.
2. Run checks again in LiveCue Setup.
3. If it is still red, restart your computer and start the relay again.

1. 关闭其他 LiveCue relay 的 Terminal / 命令行窗口。
2. 回到 LiveCue Setup 重新点击检查。
3. 如果还是红灯，重启电脑后再次启动 relay。

## macOS says the relay script cannot be opened / macOS 提示脚本无法打开

What it means:

这通常表示：

macOS blocked a downloaded command file.

macOS 拦截了下载来的 command 文件。

Try:

可以这样做：

1. Open LiveCue Setup.
2. Copy the fallback relay command.
3. Paste it into Terminal.
4. Choose `Start LiveCue ASR Relay.command`.
5. Press Enter.

## Vision check is red / Vision 是红灯

What it means:

这通常表示：

The vision model key, endpoint, or model name is not working.

视觉模型的 key、endpoint 或 model name 不可用。

Try:

可以这样做：

1. Confirm the API key is pasted correctly.
2. Confirm the selected provider matches the key.
3. Confirm the model is enabled in your provider console.
4. Click `Save & run checks` again.

## Skill Agent check is red / Skill Agent 是红灯

What it means:

这通常表示：

The chat model key, endpoint, or model name is not working.

Skill Agent 使用的聊天模型 key、endpoint 或 model name 不可用。

Try:

可以这样做：

1. Use the same Ark/OpenAI-compatible key as vision if your provider supports it.
2. Or choose Claude and paste a Claude key.
3. Confirm the model name is available.
4. Click `Save & run checks` again.

## LiveCue appears, but no skills show up / LiveCue 出现了，但没有技巧卡

What it means:

这通常表示：

The first evaluation has not finished yet, or the model returned no high-confidence skill.

第一轮评估还没完成，或者模型没有提炼出足够有证据的技巧。

Try:

可以这样做：

1. Wait about one minute after clicking `Start learning`.
2. Make sure the livestream is a specific room URL like `https://www.tiktok.com/@host/live`.
3. Check that ASR helper, vision, and Skill Agent checks are green.
4. Open `Debug trace` in the LiveCue panel for advanced diagnosis.

## TikTok page shows no LiveCue entry / TikTok 页面没有 LiveCue 入口

Try:

可以这样做：

1. Go to `chrome://extensions`.
2. Click `Reload` on LiveCue.
3. Refresh the TikTok page.
4. Make sure the extension is enabled.
