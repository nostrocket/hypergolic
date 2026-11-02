#!/usr/bin/env python3
"""Independent complete PNG/pixel/color comparison using Pillow; no native preparer imports."""
import argparse,hashlib,io,json,math,struct,zlib
from pathlib import Path
from PIL import Image,ImageCms

def verify(body,expected,gamut,needles,rms_limit=4):
 assert body[:8]==b'\x89PNG\r\n\x1a\n';at=8;chunks=[]
 while at<=len(body)-12:
  length=struct.unpack('>I',body[at:at+4])[0];assert length<=len(body)-at-12
  tag=body[at+4:at+8];payload=body[at+8:at+8+length]
  assert zlib.crc32(tag+payload)==struct.unpack('>I',body[at+8+length:at+12+length])[0]
  assert tag in [b'IHDR',b'PLTE',b'tRNS',b'IDAT',b'IEND',b'sRGB',b'iCCP',b'gAMA',b'cHRM',b'cICP',b'sBIT',b'bKGD',b'pHYs'];chunks.append(tag.decode());at+=length+12
  if tag==b'IEND':assert length==0 and at==len(body);break
 assert at==len(body) and chunks[0]=='IHDR' and chunks[-1]=='IEND' and 'IDAT' in chunks
 for value in needles:assert value.encode() not in body
 actual=Image.open(io.BytesIO(body));assert actual.format=='PNG' and getattr(actual,'n_frames',1)==1;actual.load()
 reference=Image.open(expected);reference.load();assert actual.size==reference.size
 profile=actual.info.get('icc_profile');expected_profile=reference.info.get('icc_profile')
 if gamut=='p3':
  assert profile and expected_profile,'P3 profile lost'
  a=ImageCms.ImageCmsProfile(io.BytesIO(profile)).profile;e=ImageCms.ImageCmsProfile(io.BytesIO(expected_profile)).profile
  for field in ['red_colorant','green_colorant','blue_colorant','media_white_point']:
   av=getattr(a,field)[0];ev=getattr(e,field)[0];assert max(abs(x-y) for x,y in zip(av,ev))<0.001,(field,av,ev) # Canonical Apple/Skia ICC adaptation coefficients differ slightly.
 elif profile:
  assert 'sRGB' in ImageCms.getProfileName(ImageCms.ImageCmsProfile(io.BytesIO(profile))), 'Unexpected rendering profile'
 pixels=list(actual.convert('RGB').get_flattened_data());target=list(reference.convert('RGB').get_flattened_data())
 errors=[abs(x-y) for ap,ep in zip(pixels,target) for x,y in zip(ap,ep)];rms=math.sqrt(sum(n*n for n in errors)/len(errors));assert rms<=rms_limit,(rms,max(errors))
 width,height=actual.size
 for x,y in [(width//4,height//4),(3*width//4,height//4),(width//4,3*height//4),(3*width//4,3*height//4)]:
  assert max(abs(a-b) for a,b in zip(pixels[y*width+x],target[y*width+x]))<=12,'Oriented quadrant color mismatch'
 return {'sha256':hashlib.sha256(body).hexdigest(),'size':len(body),'dimensions':actual.size,'gamut':gamut,'rmsChannelError':rms,'maxChannelError':max(errors),'chunks':chunks}

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--fixtures',type=Path,required=True);p.add_argument('--prepared',type=Path,required=True);p.add_argument('--output',type=Path,required=True);args=p.parse_args();manifest=json.load(open(args.fixtures/'photos.json'));results=[]
 for item in manifest['files']:
  result=verify((args.prepared/(item['file']+'.png')).read_bytes(),args.fixtures/(item['file']+'.expected.png'),item['gamut'],manifest['metadataNeedles'],8 if item['file'].endswith('.heic') else 4);results.append({'file':item['file'],**result})
 args.output.write_text(json.dumps({'status':'passed','scope':__doc__,'results':results},indent=2)+'\n');print('PASS independent pixels/orientation/color/metadata for',len(results),'prepared files')
