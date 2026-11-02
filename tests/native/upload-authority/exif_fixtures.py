"""Independent TIFF recipes with primary orientation, GPS/date fields and a thumbnail directory."""
import struct


def exif_profile(thumbnail, order='<', rotation=1, thumbnail_rotation=6):
    # Directory layout and pointed-to data are independently assembled in this fixture.
    directories = {
        'main': [(274,3,1,rotation),(271,2,0,b'Private camera\0'),(34665,4,1,'exif'),(34853,4,1,'gps')],
        'exif': [(36867,2,0,b'2026:01:02 03:04:05\0'),(40965,4,1,'interop')],
        'interop': [(1,2,4,b'R98\0')],
        'gps': [(1,2,2,b'N\0'),(2,5,3,struct.pack(order+'IIIIII',1,1,2,1,3,1))],
        'thumbnail': [(274,3,1,thumbnail_rotation),(513,4,1,'jpeg'),(514,4,1,len(thumbnail))],
    }
    offsets = {}; cursor = 8
    for name, entries in directories.items():offsets[name] = cursor;cursor += 2+12*len(entries)+4
    payload = b''; tables = []
    for name, entries in directories.items():
        encoded = []
        for tag, kind, count, value in entries:
            if isinstance(value, bytes):
                count = count or len(value)
                if len(value) <= 4:slot = value.ljust(4,b'\0')
                else:slot = struct.pack(order+'I',cursor+len(payload));payload += value
            elif isinstance(value, str):slot = value
            elif kind == 3:slot = struct.pack(order+'H',value)+bytes(2)
            else:slot = struct.pack(order+'I',value)
            encoded.append((tag,kind,count,slot))
        tables.append((name,encoded))
    offsets['jpeg'] = cursor+len(payload)
    body = (b'II' if order == '<' else b'MM')+struct.pack(order+'HI',42,8)
    for name, entries in tables:
        body += struct.pack(order+'H',len(entries))
        for tag,kind,count,slot in entries:
            body += struct.pack(order+'HHI',tag,kind,count)+(struct.pack(order+'I',offsets[slot]) if isinstance(slot,str) else slot)
        body += struct.pack(order+'I',offsets['thumbnail'] if name == 'main' else 0)
    return body+payload+thumbnail


def write_exif_fixtures(out, thumbnail):
    def profile(order='<', rotation=1, thumbnail_rotation=6):
        return exif_profile(thumbnail, order, rotation, thumbnail_rotation)

    cases=[]
    def add(name,data,expected):
        filename='exif-'+name+'.tiff';(out/filename).write_bytes(data);cases.append(filename+'\t'+str(expected))
    for order in ['<','>']:
        for rotation in range(1,9):add(('little-' if order=='<' else 'big-')+str(rotation),profile(order,rotation),rotation)
    good=profile();add('valid',good,1)
    for name, offset, replacement in [
        ('bad-magic',2,b'\0\0'),('header-offset',4,struct.pack('<I',2)),
        ('huge-offset',4,bytes([255])*4),('huge-count',8,bytes([255])*2),
        ('bad-type',12,b'\0\0'),('zero-values',14,bytes(4)),
        ('duplicate-tag',22,struct.pack('<H',274)),('cycle',42,struct.pack('<I',8)),
        ('bad-pointer-type',36,struct.pack('<H',3)),('bad-data-offset',30,bytes([255])*4),
        ('bad-next-directory',58,bytes([255])*4),('bad-thumbnail-end',len(good)-1,b'\0')]:
        add(name,good[:offset]+replacement+good[offset+len(replacement):],0)
    add('orientation-zero',profile(rotation=0),0);add('orientation-nine',profile(rotation=9),0)
    add('bad-thumbnail-orientation',profile(thumbnail_rotation=9),0)
    # Empty first IFD and explicit zero next IFD: absent orientation means normal.
    add('absent-orientation',b'II'+struct.pack('<HIHI',42,8,0,0),1)
    def chain(directory_count, entries):
        sizes = [6 + 12 * count for count in entries]
        offsets = [8]
        for size in sizes[:-1]:offsets.append(offsets[-1] + size)
        body = b'II' + struct.pack('<HI',42,8)
        for index in range(directory_count):
            body += struct.pack('<H',entries[index])
            for tag in range(entries[index]):body += struct.pack('<HHII',50000+tag,4,1,0)
            body += struct.pack('<I',offsets[index+1] if index+1 < directory_count else 0)
        return body
    add('directory-limit',chain(32,[0]*32),1)
    add('directory-over-limit',chain(33,[0]*33),0)
    add('entry-limit',chain(1,[128]),1)
    add('entry-over-limit',chain(1,[129]),0)
    add('total-limit',chain(8,[128]*8),1)
    add('total-over-limit',chain(9,[128]*8+[1]),0)
    thumbnail_length_tag = good.index(struct.pack('<HHI',514,4,1))
    add('unpaired-thumbnail',good[:thumbnail_length_tag]+struct.pack('<H',50000)+good[thumbnail_length_tag+2:],0)
    (out/'exif-cases.tsv').write_text('\n'.join(cases)+'\n')
