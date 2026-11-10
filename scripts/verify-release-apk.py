"""Verify packaged notices and ARM64 ELF alignment without extracting APK paths."""
import json
import struct
import sys
import zipfile


def verify_elf(data):
    if len(data) < 64 or data[:6] != b'\x7fELF\x02\x01':
        raise ValueError('Expected a little-endian ELF64 library')
    if struct.unpack_from('<H', data, 18)[0] != 183:
        raise ValueError('Expected an ARM64 library')
    offset = struct.unpack_from('<Q', data, 32)[0]
    size, count = struct.unpack_from('<HH', data, 54)
    if size < 56 or not count or offset + size * count > len(data):
        raise ValueError('Invalid ELF program headers')
    loads = 0
    for index in range(count):
        header = struct.unpack_from('<IIQQQQQQ', data, offset + index * size)
        kind, _, file_offset, virtual_address, _, _, _, alignment = header
        if kind == 1:
            loads += 1
            if alignment < 16384 or alignment & (alignment - 1) or (file_offset - virtual_address) % 16384:
                raise ValueError('Native library does not support 16 KB page alignment')
    if not loads:
        raise ValueError('ELF has no loadable segments')


def verify_apk(filename, version, version_code):
    with zipfile.ZipFile(filename) as apk:
        names = apk.namelist()
        if len(names) != len(set(names)):
            raise ValueError('APK contains duplicate entries')
        config = json.loads(apk.read('assets/app.config'))
        if (config['extra']['hypergolic']['variant'] != 'production'
                or config['android']['package'] != 'space.hypergolic'
                or config['version'] != version
                or config['android']['versionCode'] != int(version_code)):
            raise ValueError('Embedded Expo config is not the expected production release')
        for folder in ('notices', 'archive-notices', 'cpp-notices', 'compiler-notices'):
            if f'assets/{folder}/manifest.json' not in names:
                raise ValueError(f'Missing packaged {folder} manifest')
        libraries = [name for name in names if name.startswith('lib/') and name.endswith('.so')]
        if not libraries:
            raise ValueError('No native libraries found')
        for name in libraries:
            if not name.startswith('lib/arm64-v8a/'):
                raise ValueError('Unexpected native architecture')
            verify_elf(apk.read(name))
        print(f'Verified notices and 16 KB ELF alignment for {len(libraries)} ARM64 libraries.')


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit('Usage: verify-release-apk.py APK VERSION VERSION_CODE')
    verify_apk(*sys.argv[1:])
