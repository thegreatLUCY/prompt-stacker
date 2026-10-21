# Chrome Web Store listing — 1.6.0 draft

Do not submit until the release checks pass. The older screenshot claiming
"No network calls" is obsolete and must not be reused for this version.

## Short description

Queue prompts and auto-send the next when the AI replies. Save ChatGPT images as a ZIP. ChatGPT, Claude, Gemini & DeepSeek.

## Detailed description

Queue your prompts, reuse your workflows, and save your ChatGPT images.

Prompt Stacker adds a compact panel to ChatGPT, Claude, Gemini and DeepSeek.
Add a sequence of prompts, then start the queue. Each prompt sends when the
previous reply finishes. Pause, resume, stop, set a delay, or repeat a sequence.

- Save reusable prompt chains in the Library tab.
- Use {{topic}} variables and {{last_reply}} to build connected workflows.
- Reorder and edit queued prompts, with Undo for removals and clearing.
- Retry or skip a failed send instead of silently advancing.
- Collapse the panel and use keyboard shortcuts.
- Export and restore your prompt workflows.

NEW: CHATGPT IMAGES

- Browse generated images in a full-screen picker.
- Select images, preview them, and download a ZIP with an image index.
- Track saved images and select new images since your previous download.
- Grab generated images from the current conversation.
- Preserve the image bytes returned by the server without re-encoding.
- Split large downloads into multiple ZIP parts.

Image features require a signed-in ChatGPT session. They are available on
ChatGPT; prompt queue features also support Claude, Gemini and DeepSeek.
The queue and image downloads take turns to avoid conflicting jobs.

PRIVACY

No developer servers, analytics or advertising trackers. Your queue is stored
locally. Saved chains and settings may sync through your own Chrome account.
Queue prompts are sent to the AI site you use. Image features request your
images from ChatGPT using your existing session and save ZIPs on your device.
ZIP indexes and exported backups may contain prompts; review them before sharing.

Source and privacy policy:
https://github.com/thegreatLUCY/prompt-stacker
https://github.com/thegreatLUCY/prompt-stacker/blob/main/PRIVACY.md

## Dashboard preparation

Single purpose: manage reusable AI prompt workflows and save their generated
ChatGPT image outputs.

Storage justification: save the queue, chains, settings, interface preferences
and image-download history; chains/settings can use the user's Chrome Sync.

Site access justification: read interface state and replies and submit queued
prompts on the supported AI sites; on ChatGPT, fetch the requested generated
image metadata and original files using the user's existing signed-in session.

Remote code: none.

Review the dashboard's current data-handling questions against PRIVACY.md.
Do not copy the old instruction to leave every category unchecked. Website
content and authentication information are handled for the requested features,
even though they are not sent to the developer. Chrome requires disclosure of
local processing too:
https://developer.chrome.com/docs/webstore/program-policies/user-data-faq

Use the five reviewed screenshots under `store/v1.6/` and the small promo image.
They use synthetic prompts and artwork, not the owner's account.
