# Privacy Policy — Prompt Stacker

_Last updated: 2026-10-21 (version 1.6.0)_

Prompt Stacker queues prompts on supported AI chat sites and, when you request
it on ChatGPT, lets you select and download generated images.

## Data used to provide these features

The queue reads the chat interface and replies to detect completion and support
features such as `{{last_reply}}`. Starting a queue sends your queued prompts to
the AI service open in that tab, under that service's terms and privacy policy.

When you open the ChatGPT image library or grab a thread, the extension requests
your session, image metadata, conversation assets and image files from ChatGPT
and its image hosts using your existing signed-in session. A session access
token is held in page memory for these requests; the extension does not save it
in extension storage or send it to the developer. It does not require you to
provide a password or API key.

The developer receives no prompts, replies, images, credentials or usage reports.
There are no developer-operated servers, analytics, advertising trackers, or
remote executable code.

## Storage and downloaded files

- Your working queue and panel position are saved in Chrome's local extension
  storage. Saved prompt chains and settings use Chrome Sync when available,
  falling back to local storage. Chrome Sync is managed by your Google account;
  the developer cannot access it.
- Image download history, including saved image identifiers, the download
  watermark, failure details and picker preferences, is saved locally in Chrome.
  The loaded image list and session token are held in memory.
- Images are saved to ZIP files you download. The included `index.tsv` can
  contain image identifiers, dates, dimensions, prompts and failure details.
  These archives and exported prompt backups may contain private content;
  review them before sharing them.

Saved extension data persists until you remove it using the interface, clear
the extension's storage, or uninstall the extension. Downloaded ZIPs and exported
backups remain until you delete those files yourself. Closing or reloading a tab
clears that tab's in-memory session token and loaded image list.

## Permissions and destinations

The `storage` permission saves the data described above. The content scripts run
on ChatGPT, Claude, Gemini and DeepSeek to operate the queue. Image features run
only on ChatGPT. Image requests use ChatGPT and its existing image hosts over
HTTPS. Data is not sold, used for advertising, or sent to unrelated services.

## Contact

Questions: https://github.com/thegreatLUCY/prompt-stacker/issues
Please do not post private prompts, images, session tokens or download archives
in a public issue.
