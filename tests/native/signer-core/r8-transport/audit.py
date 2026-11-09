#!/usr/bin/env python3
"""Require both exact compiled JNI upcall members in an actual DEX or APK."""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import zipfile

CLASS = 'Lorg/nostrocket/hypergolic/signercore/NativeTransportCrypto;'
SIGNATURE = '([B[B)[B'


def member(data, owner_class, member_name, signature, require_static):
    if data[:4] != b'dex\n':
        raise ValueError('Not a DEX file')
    u32 = lambda offset: struct.unpack_from('<I', data, offset)[0]

    def leb(offset):
        value = 0
        for shift in range(0, 35, 7):
            byte = data[offset]
            offset += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value, offset
        raise ValueError('Invalid DEX integer')

    def string(index):
        offset = u32(u32(60) + index * 4)
        _, offset = leb(offset)
        return data[offset:data.index(0, offset)].decode('utf-8', errors='replace')

    types = [string(u32(u32(68) + index * 4)) for index in range(u32(64))]

    def method(index):
        owner, proto, name = struct.unpack_from('<HHI', data, u32(92) + index * 8)
        _, result, parameters = struct.unpack_from('<III', data, u32(76) + proto * 12)
        arguments = [] if not parameters else [types[struct.unpack_from('<H', data,
            parameters + 4 + item * 2)[0]] for item in range(u32(parameters))]
        return types[owner], string(name), '(' + ''.join(arguments) + ')' + types[result]

    for index in range(u32(96)):
        offset = u32(100) + index * 32
        if types[u32(offset)] != owner_class:
            continue
        position = u32(offset + 24)
        if not position:
            raise ValueError('JNI callback class has no compiled members')
        sizes = []
        for _ in range(4):
            size, position = leb(position)
            sizes.append(size)
        for _ in range(sizes[0] + sizes[1]):
            _, position = leb(position)
            _, position = leb(position)
        for count in sizes[2:]:
            method_index = 0
            for _ in range(count):
                delta, position = leb(position)
                flags, position = leb(position)
                code, position = leb(position)
                method_index += delta
                if method(method_index) == (owner_class, member_name, signature):
                    if bool(flags & 8) != require_static or flags & (0x100 | 0x400) or not code or not u32(code + 12):
                        raise ValueError('JNI member has wrong static flag or missing compiled code')
                    return {'class': owner_class, 'method': member_name, 'descriptor': signature,
                            'static': require_static, 'compiledInstructions': u32(code + 12)}
        raise ValueError('Exact JNI member is absent')
    raise ValueError('JNI named class is absent')


def audit(path):
    raw = path.read_bytes()
    entries = []
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            entries = [(name, archive.read(name)) for name in archive.namelist()
                       if name.startswith('classes') and name.endswith('.dex')]
    else:
        entries = [(path.name, raw)]
    result = {'artifactSha256': hashlib.sha256(raw).hexdigest()}
    obligations = [('callback', CLASS, 'hmac', SIGNATURE, True),
                   ('denial', 'Lorg/nostrocket/hypergolic/signercore/NativeSignerCore$Denied;',
                    '<init>', '(Ljava/lang/String;)V', False)]
    for label, owner_class, member_name, signature, is_static in obligations:
        found = []
        for name, data in entries:
            try:
                found.append({'dex': name, **member(data, owner_class, member_name, signature, is_static)})
            except ValueError as error:
                if str(error) != 'JNI named class is absent':
                    raise
        if len(found) != 1:
            raise ValueError('Expected exactly one compiled JNI member: ' + label)
        result[label] = found[0]
    return result



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = audit(args.artifact)
    with args.output.open('x') as output:
        output.write(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
