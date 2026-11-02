#!/usr/bin/env python3
"""Render the shell's original gradient artwork using only the Python standard library."""
import math
import struct
import zlib
from pathlib import Path


def mix(a, b, t):
    t = max(0, min(1, t))
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def png(path, width, height, pixel):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            rows.extend(pixel(x / (width - 1), y / (height - 1)))
    data = b'\x89PNG\r\n\x1a\n'
    data += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
    data += chunk(b'IDAT', zlib.compress(bytes(rows), 9)) + chunk(b'IEND', b'')
    path.write_bytes(data)


def render(output):
    output.mkdir(parents=True, exist_ok=True)
    for name, void, sky, rim, core, ignition in [
        ('dark', (8, 15, 23), (24, 42, 60), (37, 56, 74), (255, 243, 220), (245, 160, 75)),
        ('light', (255, 255, 255), (247, 248, 250), (213, 221, 229), (255, 255, 255), (170, 71, 8)),
    ]:
        def sky_pixel(x, y):
            t = min(1, math.hypot((x - .5) * 1.1, y * 1.45))
            return (*mix(sky, void, t), 255)

        def planet_pixel(x, y):
            distance = math.hypot(x - .5, y - .5)
            alpha = round(max(0, min(1, (.5 - distance) * 900)) * 255)
            shade = mix(rim, void, min(1, y * 5.5))
            shade = mix(shade, (159, 186, 208) if name == 'dark' else (247, 250, 253), math.exp(-max(0, .5 - distance) * 1400) * .35)
            return (*shade, alpha)

        def beam_pixel(x, y):
            distance = abs(x - .5)
            core_alpha = max(0, 1 - distance * 70) * .7
            glow_alpha = math.exp(-distance * 18) * .15
            envelope = math.sin(y * math.pi) ** .7
            return (*ignition, round(min(1, core_alpha + glow_alpha) * envelope * 255))

        def flare_pixel(x, y):
            distance = math.hypot((x - .5) * 2, (y - .5) * 2)
            glow = max(0, 1 - distance) ** 2
            return (*mix(ignition, core, max(0, 1 - distance * 3)), round(glow * .8 * 255))

        png(output / f'sky-{name}.png', 512, 1024, sky_pixel)
        png(output / f'planet-{name}.png', 2400, 2400, planet_pixel)
        png(output / f'beam-{name}.png', 80, 1024, beam_pixel)
        png(output / f'flare-{name}.png', 600, 120, flare_pixel)


if __name__ == '__main__':
    render(Path(__file__).resolve().parents[1] / 'assets' / 'shell')
