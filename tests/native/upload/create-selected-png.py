#!/usr/bin/env python3
"""Independent device seed: original pixel bytes plus actual Exif/device/date/GPS fields."""
import argparse,base64,hashlib,json,re,struct,zlib
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=Path,required=True);args=p.parse_args()
root=Path(__file__).resolve().parents[3]
expected=base64.b64decode(re.search(r"const encoded = '([^']+)'",(root/'napplets/upload-lab/src/main.ts').read_text()).group(1))
def entry(tag,kind,count,value):return struct.pack('<HHI',tag,kind,count)+value
count=4; payload_offset=8+2+12*count+4
make=b'Private fixture camera\0'; date=b'2026:01:02 03:04:05\0'
gps_offset=payload_offset+len(make)+len(date); rational_offset=gps_offset+2+2*12+4
exif=(b'II'+struct.pack('<HIH',42,8,count)+entry(274,3,1,struct.pack('<H',1)+bytes(2))+
      entry(271,2,len(make),struct.pack('<I',payload_offset))+entry(306,2,len(date),struct.pack('<I',payload_offset+len(make)))+
      entry(34853,4,1,struct.pack('<I',gps_offset))+bytes(4)+make+date+struct.pack('<H',2)+
      entry(1,2,2,b'N\0\0\0')+entry(2,5,3,struct.pack('<I',rational_offset))+bytes(4)+struct.pack('<IIIIII',1,1,2,1,3,1))
def chunk(name,body):
    encoded=name.encode()+body;return struct.pack('>I',len(body))+encoded+struct.pack('>I',zlib.crc32(encoded))
selected=expected[:33]+chunk('eXIf',exif)+chunk('tEXt',b'Description\0Private fixture location/date/device')+expected[33:]
args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_bytes(selected)
manifest={'kind':'hypergolic-selected-photo-seed-v1','originalSha256':hashlib.sha256(selected).hexdigest(),'originalSize':len(selected),
          'expectedPreparedSha256':hashlib.sha256(expected).hexdigest(),'expectedPreparedSize':len(expected),
          'metadata':['Exif orientation 1','Exif Make','Exif DateTime','GPS latitude reference and rationals','PNG private description'],
          'scope':'Generated public fixture, no personal user data. Expected sanitized bytes are independently supplied original pixel PNG.'}
args.output.with_suffix('.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest))
