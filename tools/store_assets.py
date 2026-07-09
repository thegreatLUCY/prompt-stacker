#!/usr/bin/env python3
"""Compose 1280x800 Chrome Web Store screenshots + a 440x280 promo tile.
Places the real panel shots on a branded dark canvas with an accent glow."""
import os
import math
import random
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "screenshots")
OUT = os.path.join(ROOT, "store")
os.makedirs(OUT, exist_ok=True)
AV = "/System/Library/Fonts/Avenir Next.ttc"


def font(size, idx=0):
    return ImageFont.truetype(AV, size, index=idx)


HEAVY, BOLD, DEMI, MED, REG = 8, 0, 2, 5, 7


def hex2rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def canvas(w, h, accent):
    """Dark charcoal base with a soft accent glow in the top-right."""
    base = Image.new("RGB", (w, h), (18, 18, 20))
    glow = Image.new("RGB", (w, h), (18, 18, 20))
    gd = ImageDraw.Draw(glow)
    ac = hex2rgb(accent)
    cx, cy, rad = int(w * 0.82), int(h * 0.12), int(w * 0.6)
    for i in range(rad, 0, -6):
        t = i / rad
        col = tuple(int(18 + (a - 18) * (1 - t) * 0.5) for a in ac)
        gd.ellipse([cx - i, cy - i, cx + i, cy + i], fill=col)
    glow = glow.filter(ImageFilter.GaussianBlur(90))
    base = Image.blend(base, glow, 0.9)
    # subtle grain
    noise = Image.effect_noise((w, h), 14).convert("L")
    base = Image.composite(
        Image.new("RGB", (w, h), (255, 255, 255)), base,
        noise.point(lambda p: int(p * 0.05))
    ) if False else base
    return base


def paste_panel(bg, panel_path, box_h, right_pad, cy, max_w=99999):
    """Scale panel to box_h tall (but never wider than max_w), drop it on the
    right with a soft shadow."""
    p = Image.open(panel_path).convert("RGBA")
    scale = min(box_h / p.height, max_w / p.width)
    p = p.resize((int(p.width * scale), int(p.height * scale)), Image.LANCZOS)
    x = bg.width - p.width - right_pad
    y = cy - p.height // 2
    # shadow
    sh = Image.new("RGBA", bg.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle(
        [x + 6, y + 18, x + p.width + 6, y + p.height + 18], radius=26,
        fill=(0, 0, 0, 150))
    sh = sh.filter(ImageFilter.GaussianBlur(34))
    bg.paste(Image.alpha_composite(bg.convert("RGBA"), sh).convert("RGB"), (0, 0))
    bg.paste(p, (x, y), p)
    return x


def wrap_draw(d, text, f, x, y, fill, lh, spacing=0):
    for line in text.split("\n"):
        d.text((x, y), line, font=f, fill=fill)
        bb = d.textbbox((0, 0), line, font=f)
        y += (bb[3] - bb[1]) + lh
    return y


def slide(name, panel, accent, kicker, headline, sub, box_h=760, max_w=560, cy=None):
    W, H = 1280, 800
    bg = canvas(W, H, accent)
    paste_panel(bg, os.path.join(SHOTS, panel), box_h, 90,
                cy if cy is not None else H // 2, max_w=max_w)
    d = ImageDraw.Draw(bg)
    ac = hex2rgb(accent)
    x = 96
    # kicker
    d.text((x, 150), kicker.upper(), font=font(22, DEMI), fill=ac)
    y = 196
    y = wrap_draw(d, headline, font(66, HEAVY), x, y, (245, 245, 247), 8)
    y += 24
    wrap_draw(d, sub, font(27, MED), x, y, (172, 174, 180), 12)
    # wordmark bottom-left
    d.text((x, H - 78), "Prompt Stacker", font=font(24, BOLD), fill=(230, 230, 232))
    d.text((x + 214, H - 76), "· free · open source", font=font(20, MED),
           fill=(140, 142, 148))
    bg.save(os.path.join(OUT, name))
    print("  ✓ store/" + name)


slide("01-hero.png", "queue-dark.png", "#19c37d",
      "Prompt Stacker",
      "Queue your prompts.\nWalk away.",
      "Line up a whole stack of prompts and let each one\nsend itself the moment the AI finishes the last reply.")

slide("02-auto.png", "queue-dark.png", "#19c37d",
      "Hands-free",
      "It waits, then sends\nthe next one.",
      "No more babysitting the tab. Prompt Stacker watches\nfor the reply to finish — then fires the next prompt.")

slide("03-platforms.png", "queue-light.png", "#d97757",
      "One extension, many AIs",
      "ChatGPT, Claude,\nGemini & more.",
      "Auto-detects the site and tints to its brand. Follows\neach platform's own light and dark mode.")

slide("04-chains.png", "library-dark.png", "#4b8bf5",
      "Reusable workflows",
      "Save your favorite\nprompt chains.",
      "Store a sequence once and reload it in a click. Use\n{{last_reply}} to feed each answer into the next prompt.")

slide("05-private.png", "pill-dark.png", "#19c37d",
      "Private by design",
      "100% local.\nNothing leaves\nyour browser.",
      "No API keys. No network calls. No accounts.\nJust a queue and a click — collapses to a tidy pill.",
      box_h=200, max_w=470, cy=560)

# --- 440x280 small promo tile ---
W, H = 440, 280
tile = canvas(W, H, "#19c37d")
d = ImageDraw.Draw(tile)
ic = Image.open(os.path.join(ROOT, "icon128.png")).convert("RGBA").resize((92, 92), Image.LANCZOS)
tile.paste(ic, (34, 44), ic)
d.text((34, 150), "Prompt Stacker", font=font(30, HEAVY), fill=(245, 245, 247))
d.text((34, 190), "Queue prompts. Walk away.", font=font(19, MED), fill=(175, 177, 183))
d.text((34, 220), "ChatGPT · Claude · Gemini", font=font(16, DEMI), fill=hex2rgb("#19c37d"))
tile.save(os.path.join(OUT, "promo-440x280.png"))
print("  ✓ store/promo-440x280.png")
