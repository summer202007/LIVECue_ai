# Privacy

LiveCue is designed as a local-first demo.

## What LiveCue Collects

When learning is active, the extension may collect:

- Current TikTok LIVE page URL and room metadata.
- Publicly visible comments shown on the page.
- Livestream visual frames.
- Page audio segments for ASR.
- Generated skill cards and debug traces.

## Where Data Goes

- API keys are stored in local Chrome extension storage.
- ASR audio is sent to the local relay at `http://127.0.0.1:17395/asr`.
- The local relay sends ASR requests to the configured Volcengine endpoint.
- Vision and Skill Agent requests are sent to the model providers configured by the user.
- Saved skills and debug traces are stored locally in Chrome extension storage.

## What Is Not Included In Release Packages

Public release packages should not include:

- Private API keys.
- Local debug output.
- Captured livestream data.
- Internal evaluation files.
- Internal business knowledge or rubric assets.

## User Control

Users can stop learning from the LiveCue panel, close the ASR relay Terminal window, remove the Chrome extension, and clear local extension storage from Chrome.
