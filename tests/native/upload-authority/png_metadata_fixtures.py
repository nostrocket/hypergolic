"""Independent PNG/TIFF recipe fixtures, with exact sanitized-byte expectations."""
import struct
import zlib


def write_metadata_fixtures(out, png, chunk, good):
    def exif(order='<', orientation=1, next_directory=0):
        # Orientation, device, date and a private GPS label in a TIFF field.
        # The GPS label is fixture data, not a claim to validate every GPS IFD.
        strings = [(271, b'Private device\0'), (306, b'2026:01:02 03:04:05\0'),
                   (270, b'GPS/private location; embedded thumbnail/private\0')]
        offset = 8 + 2 + 12 * (len(strings) + 1) + 4
        entries = [struct.pack(order+'HHI', 274, 3, 1) + struct.pack(order+'H', orientation) + bytes(2)]
        payload = b''
        for tag, value in strings:
            entries.append(struct.pack(order+'HHII', tag, 2, len(value), offset+len(payload)))
            payload += value
        return (b'II' if order == '<' else b'MM') + struct.pack(order+'HIH', 42, 8, len(entries)) + b''.join(entries) + struct.pack(order+'I', next_directory) + payload

    text = chunk('tEXt', b'Location\0GPS/private location')
    compressed = chunk('zTXt', b'Device\0\0'+zlib.compress(b'Private device/date/thumbnail'))
    international = chunk('iTXt', b'XML:com.adobe.xmp\0\0\0\0\0<GPS>private</GPS>')
    timestamp = chunk('tIME', struct.pack('>HBBBBB', 2026, 1, 2, 3, 4, 5))
    color = chunk('sRGB', b'\0')
    cases = []

    def add(name, data, expected=None):
        filename = 'metadata-'+name+'.png'
        (out/filename).write_bytes(data)
        expected_name = 'DENY'
        if expected is not None:
            expected_name = 'expected-'+name+'.png'
            (out/expected_name).write_bytes(expected)
        cases.append(filename+'\t'+expected_name)

    add('text', png(before=text), good)
    add('compressed-text', png(before=compressed), good)
    add('international-text', png(before=international), good)
    add('timestamp', png(before=timestamp), good)
    add('exif-little', png(before=chunk('eXIf', exif())), good)
    add('exif-big', png(before=chunk('eXIf', exif('>'))), good)
    add('all', png(before=text+compressed+international+timestamp+chunk('eXIf', exif())), good)
    add('color', png(before=text+color+chunk('eXIf', exif('>')), after=timestamp), png(before=color))
    add('compressed-bomb', png(before=chunk('zTXt', b'Device\0\0'+zlib.compress(b'x'*16_000_000))), good)
    add('rotated', png(before=chunk('eXIf', exif(orientation=6))))
    add('mirrored', png(before=chunk('eXIf', exif(orientation=2))))
    add('bad-orientation', png(before=chunk('eXIf', exif(orientation=0))))
    add('duplicate-exif', png(before=chunk('eXIf', exif())*2))
    add('extra-image-directory', png(before=chunk('eXIf', exif(next_directory=8))))
    for name, data in [('truncated-exif', exif()[:19]), ('bad-exif-offset', exif()[:4]+bytes([255])*4+exif()[8:]),
                       ('bad-exif-count', exif()[:8]+bytes([255])*2+exif()[10:]),
                       ('bad-value-offset', exif()[:30]+bytes([255])*4+exif()[34:])]:
        add(name, png(before=chunk('eXIf', data)))
    corrupted = bytearray(text); corrupted[-1] ^= 1
    add('text-crc', png(before=corrupted))
    add('text-length', png(before=struct.pack('>I', 2**31-1)+text[4:]))
    add('duplicate-time', png(before=timestamp*2))
    add('bad-time', png(before=chunk('tIME', struct.pack('>HBBBBB', 2026, 0, 2, 3, 4, 5))))
    add('unknown', png(before=text+chunk('aaAA', b'private')))
    add('animation', png(before=text+chunk('acTL', bytes(8))))
    add('unsupported-color', png(before=text+chunk('iCCP', b'profile\0\0'+zlib.compress(b'private'))))
    add('late-color', png(before=text, after=color))
    add('duplicate-color', png(before=text+color*2))
    add('chunk-limit', png(before=text*4096))
    # Removing an ancillary chunk must not repair an invalid nonconsecutive IDAT stream.
    split = good.index(b'IDAT')-4
    raw_idat = good[split:-12]
    add('split-idat', good[:split]+raw_idat+text+chunk('IDAT', b'')+good[-12:])
    add('after-end', good+text)
    add('before-header', good[:8]+text+good[8:])
    (out/'png-metadata-cases.tsv').write_text('\n'.join(cases)+'\n')
