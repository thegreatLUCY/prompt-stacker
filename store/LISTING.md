# Chrome Web Store — listing copy & submission guide

Everything below is copy-paste ready. Fields map 1:1 to the Developer Console.

---

## 1. Store listing tab

**Name** (≤45 chars)
```
Prompt Stacker — Queue prompts for AI
```

**Summary / short description** (≤132 chars)
```
Queue a stack of prompts for ChatGPT, Claude & Gemini — each one sends itself when the AI finishes the previous reply.
```

**Category:** Productivity
**Language:** English

**Detailed description** (paste as-is)
```
Prompt Stacker lets you line up a whole stack of prompts and walk away. Each
prompt sends itself the moment the AI finishes the previous reply — no more
sitting there waiting to paste the next one.

It only does what you'd do by hand: type into the box and click Send when the
reply is done. No API keys, no accounts, no background automation.

━━ WHAT IT DOES ━━
• Prompt queue — stack as many prompts as you like; the next sends automatically
  when the current reply finishes.
• Works on ChatGPT, Claude, Gemini, Google AI Mode and DeepSeek — one extension,
  and it auto-detects which AI you're on.
• Chain replies — use {{last_reply}} to feed the AI's previous answer straight
  into the next prompt.
• Fill-in blanks — write {{topic}} and fill it in once when you press Start.
• Delay, pause, resume, stop — full control mid-run.
• Reorder & edit queued prompts; save sequences you reuse as one-click chains.
• Repeat the whole queue N times to generate variations.
• Auto-continue truncated replies; optional auto-pause on usage limits.
• Follows each site's light / dark mode automatically.
• Collapses to a tidy pill with a live queue count.
• Keyboard shortcuts and one-file backup / restore.

━━ PRIVACY ━━
Everything stays in your browser. Prompt Stacker makes zero network requests and
sends none of your data anywhere. It requests a single permission — storage — to
remember your queue, chains and settings locally.

━━ OPEN SOURCE ━━
The full source is public: https://github.com/thegreatLUCY/prompt-stacker
```

---

## 2. Privacy practices tab  (this is what usually blocks approval — fill it exactly)

**Single purpose**
```
Prompt Stacker queues prompts the user types and sends the next one automatically
when the AI chat page finishes its previous reply.
```

**Permission justification — `storage`**
```
Used to save the user's prompt queue, saved chains and settings locally in the
browser so they persist between sessions. No data is transmitted.
```

**Host permission justification** (for the content-script matches)
```
The panel runs only on supported AI chat sites (ChatGPT, Claude, Gemini, Google
AI Mode, DeepSeek) so it can place the user's prompt into that site's input box
and click its send button. It does not read or transmit page data anywhere.
```

**Remote code:** No, I am not using remote code.

**Data collection disclosures — check NOTHING.** For every category (personally
identifiable info, activity, web history, etc.) leave it unchecked. Then check the
three certification boxes:
- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases
- ☑ I do not use or transfer user data for purposes unrelated to my item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** required because host permissions are requested. Use the
hosted PRIVACY.md (see step 4) e.g.
`https://github.com/thegreatLUCY/prompt-stacker/blob/main/PRIVACY.md`

---

## 3. Graphic assets (already generated in this folder)

| Field | File | Size |
| --- | --- | --- |
| Store icon | ../icon128.png | 128×128 ✅ |
| Screenshots (add all 5, in order) | 01-hero … 05-private.png | 1280×800 ✅ |
| Small promo tile (optional) | promo-440x280.png | 440×280 ✅ |

---

## 4. Distribution
- **Visibility:** Public
- **Regions:** All
- **Pricing:** Free
