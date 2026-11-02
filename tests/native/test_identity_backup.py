#!/usr/bin/env python3
"""Unit coverage for the portable FLAG_SECURE PNG inspection helper."""
import struct
import sys
from pathlib import Path
import unittest
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parent))
from identity_backup import IdentityBackup


def png(rows):
    height, width = len(rows), len(rows[0]) // 3
    payload = b''.join(b'\0' + row for row in rows)
    def chunk(kind, value): return struct.pack('>I', len(value)) + kind + value + struct.pack('>I', zlib.crc32(kind + value) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(payload)) + chunk(b'IEND', b'')


class SecurePngTests(unittest.TestCase):
    def test_black_panel_passes(self):
        IdentityBackup.assert_redacted(png([b'\0' * 12 for _ in range(4)]), '[0,0][4,4]')

    def test_visible_panel_pixel_fails(self):
        rows = [b'\0' * 12 for _ in range(4)]
        rows[2] = b'\0' * 6 + b'\xff\xff\xff' + b'\0' * 3
        with self.assertRaisesRegex(RuntimeError, 'non-redacted'):
            IdentityBackup.assert_redacted(png(rows), '[0,0][4,4]')


if __name__ == '__main__': unittest.main()
