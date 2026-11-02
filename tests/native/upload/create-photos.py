#!/usr/bin/env python3
"""Independent generated photos and expected displayed pixels; requires Pillow 12.3."""
from pathlib import Path
import argparse,subprocess,shutil,struct,zlib,io,sys
from PIL import Image,ImageOps,PngImagePlugin
import json,hashlib
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
out=args.output.resolve();out.mkdir(parents=True,exist_ok=False)
image=Image.new('RGB',(64,32));colors=[(240,20,20),(20,230,30),(20,40,240),(235,210,20)]
for y in range(32):
 for x in range(64):image.putpixel((x,y),colors[(y>=16)*2+(x>=32)])
items=[]
for kind in ['jpeg','webp','png','gif']:
 for orientation in range(1,9) if kind in ['jpeg','webp','png'] else [1]:
  exif=Image.Exif();exif[274]=orientation;exif[271]='Public test camera';exif[306]='2026:01:02 03:04:05';exif[34853]={1:'N',2:(1.,2.,3.),3:'E',4:(4.,5.,6.)}
  name=f'{kind}-orientation-{orientation}.{kind}'
  options={'exif':exif.tobytes()}
  if kind=='jpeg':options.update(quality=95,subsampling=0)
  if kind=='webp':options.update(lossless=True)
  if kind=='gif':options={'comment':b'Public fixture metadata'}
  image.save(out/name,**options)
  with Image.open(out/name) as opened:
   expected=ImageOps.exif_transpose(opened).convert('RGB');expected.save(out/(name+'.expected.png'))
  data=(out/name).read_bytes();items.append({'file':name,'inputSha256':hashlib.sha256(data).hexdigest(),'orientation':orientation,'outputDimensions':[expected.width,expected.height]})

# Independent Exif graph with a real, differently oriented embedded JPEG thumbnail.
sys.path.insert(0,str(Path(__file__).parents[1]/'upload-authority'))
from exif_fixtures import exif_profile
thumbnail=io.BytesIO();Image.new('RGB',(16,8),(150,30,180)).save(thumbnail,format='JPEG',comment=b'Public private thumbnail payload')
base=io.BytesIO();image.save(base,format='JPEG',quality=95,subsampling=0)
exif=b'Exif\0\0'+exif_profile(thumbnail.getvalue(),rotation=6,thumbnail_rotation=3)
name='jpeg-thumbnail-orientation-6.jpeg';data=base.getvalue()[:2]+b'\xff\xe1'+struct.pack('>H',len(exif)+2)+exif+base.getvalue()[2:];(out/name).write_bytes(data)
with Image.open(out/name) as opened:
 expected=ImageOps.exif_transpose(opened).convert('RGB');expected.save(out/(name+'.expected.png'))
items.append({'file':name,'inputSha256':hashlib.sha256(data).hexdigest(),'orientation':6,'outputDimensions':[expected.width,expected.height],'embeddedThumbnailOrientation':3})

subprocess.run(['swift',str(Path(__file__).with_name('create-heic.swift')),str(out/'heic')],check=True)
for gamut in ['srgb','p3']:
 for orientation in [1,6]:
  name=f'heic-{gamut}-orientation-{orientation}.heic';shutil.copy2(out/'heic'/name,out/name)
  with Image.open(out/'heic'/f'reference-{gamut}.png') as reference:
   expected=reference if orientation==1 else reference.transpose(Image.Transpose.ROTATE_270)
   expected.save(out/(name+'.expected.png'))
  data=(out/name).read_bytes();items.append({'file':name,'inputSha256':hashlib.sha256(data).hexdigest(),'orientation':orientation,'outputDimensions':[expected.width,expected.height],'gamut':gamut})
name='png-p3-orientation-1.png';shutil.copy2(out/'heic/reference-p3.png',out/name);shutil.copy2(out/'heic/reference-p3.png',out/(name+'.expected.png'))
data=(out/name).read_bytes();items.append({'file':name,'inputSha256':hashlib.sha256(data).hexdigest(),'orientation':1,'outputDimensions':[512,256],'gamut':'p3'})
# Public metadata needles and complete expected pixels are independent of the native preparers.
for item in items:item.setdefault('gamut','srgb')
invalid=[]
for extension in ['jpeg','png','webp','heic']:
 source=out/('heic-srgb-orientation-1.heic' if extension=='heic' else f'{extension}-orientation-1.{extension}')
 data=source.read_bytes();name='truncated.'+extension;(out/name).write_bytes(data[:len(data)//2]);invalid.append({'file':name,'reason':'truncated container'})
for extension in ['jpeg','png','webp']:
 data=bytearray((out/f'{extension}-orientation-1.{extension}').read_bytes())
 pos=data.find(b'Exif\0\0')+6 if extension=='jpeg' else (data.find(b'eXIf')+4 if extension=='png' else data.find(b'EXIF')+8)
 assert pos>=6;little=data[pos:pos+2]==b'II';data[pos+4:pos+8]=struct.pack('<I' if little else '>I',0xfffffff0)
 if extension=='png':
  start=pos-8;length=struct.unpack('>I',data[start:start+4])[0];data[pos+length:pos+length+4]=struct.pack('>I',zlib.crc32(data[start+4:pos+length]))
 name='malformed-exif.'+extension;(out/name).write_bytes(data);invalid.append({'file':name,'reason':'out-of-bounds Exif directory'})
for extension in ['gif','webp','png']:
 name='animated.'+extension;image.save(out/name,save_all=True,append_images=[image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)],duration=100,loop=0);invalid.append({'file':name,'reason':'animated photo is unsupported'})
(out/'photos.json').write_text(json.dumps({'files':items,'invalid':invalid,'metadataNeedles':['Public test camera','2026:01:02 03:04:05','Public fixture metadata','Private camera','Public private thumbnail payload','Public photo picker HEIC proof']},indent=2)+'\n')
print(len(items),'independent orientation/color recipes and',len(invalid),'denied recipes generated')
