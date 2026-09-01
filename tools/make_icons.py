#!/usr/bin/env python3
"""
Dibuja el sello de Juez y genera los iconos de la app.

El sello: un pentagono dorado con las cinco marcas de color en sus vertices y
un rombo en el centro. Cinco colores, un arbitro en medio. Todo dibujado a
mano, sin usar ningun material de Wizards.

Uso:  python3 tools/make_icons.py
Salida: public/icon-192.png, public/icon-512.png, public/icon-maskable-512.png,
        public/apple-touch-icon.png, public/favicon.png
"""

import math
import os

from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")

TABLE = (20, 16, 12)
FRAME_TOP = (58, 46, 31)
FRAME_BOT = (28, 22, 15)
GOLD = (201, 162, 39)
GOLD_LIGHT = (231, 208, 138)
PIPS = [
    (247, 240, 218),  # blanco
    (59, 123, 181),   # azul
    (58, 52, 44),     # negro
    (180, 65, 58),    # rojo
    (78, 139, 84),    # verde
]

SS = 4  # supermuestreo: dibujamos grande y reducimos, para bordes limpios


def vertical_gradient(size, top, bottom):
    img = Image.new("RGB", (1, size), top)
    px = img.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return img.resize((size, size))


def draw_seal(size, padding_ratio=0.13, background=True, rounded=True):
    """Dibuja el sello centrado en un lienzo cuadrado."""
    S = size * SS
    if background:
        img = vertical_gradient(S, FRAME_TOP, FRAME_BOT).convert("RGBA")
        if rounded:
            mask = Image.new("L", (S, S), 0)
            ImageDraw.Draw(mask).rounded_rectangle(
                [0, 0, S - 1, S - 1], radius=int(S * 0.19), fill=255
            )
            base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
            base.paste(img, (0, 0), mask)
            img = base
    else:
        img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    d = ImageDraw.Draw(img)
    cx = cy = S / 2
    pad = S * padding_ratio
    R = (S / 2) - pad                      # radio del pentagono
    stroke = max(int(S * 0.024), SS)

    # Vertices del pentagono, punta arriba
    pts = [
        (cx + R * math.sin(2 * math.pi * i / 5), cy - R * math.cos(2 * math.pi * i / 5))
        for i in range(5)
    ]

    # Anillo exterior tenue
    d.ellipse(
        [cx - R - stroke * 2.2, cy - R - stroke * 2.2,
         cx + R + stroke * 2.2, cy + R + stroke * 2.2],
        outline=GOLD + (90,), width=max(stroke // 2, SS // 2),
    )

    # El pentagono
    d.polygon(pts, outline=GOLD, width=stroke)

    # Rombo central: el arbitro
    r = R * 0.30
    d.polygon(
        [(cx, cy - r), (cx + r * 0.72, cy), (cx, cy + r), (cx - r * 0.72, cy)],
        fill=GOLD_LIGHT,
    )

    # Las cinco marcas de color, una por vertice
    pr = R * 0.195
    for (x, y), color in zip(pts, PIPS):
        d.ellipse([x - pr, y - pr, x + pr, y + pr], fill=color,
                  outline=(11, 8, 5), width=max(stroke // 2, SS // 2))

    return img.resize((size, size), Image.LANCZOS)


def flatten(img, bg=TABLE):
    out = Image.new("RGB", img.size, bg)
    out.paste(img, (0, 0), img)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    hechos = []

    for size in (192, 512):
        p = os.path.join(OUT, f"icon-{size}.png")
        draw_seal(size).save(p)
        hechos.append(p)

    # Maskable: Android recorta hasta un 20% por cada lado, asi que el sello
    # va mas pequeno y el fondo llega hasta el borde sin esquinas redondeadas.
    p = os.path.join(OUT, "icon-maskable-512.png")
    draw_seal(512, padding_ratio=0.27, rounded=False).save(p)
    hechos.append(p)

    p = os.path.join(OUT, "apple-touch-icon.png")
    flatten(draw_seal(180, rounded=False)).save(p)
    hechos.append(p)

    p = os.path.join(OUT, "favicon.png")
    draw_seal(64, padding_ratio=0.08).save(p)
    hechos.append(p)

    for f in hechos:
        print(f"{os.path.basename(f):26} {os.path.getsize(f) / 1024:6.1f} KB")


if __name__ == "__main__":
    main()
