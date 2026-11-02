#!/usr/bin/env python3
"""Compare prepared pixels to a separate complete native decode, before preparation."""
import argparse,json
from pathlib import Path
from PIL import Image
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--fixtures',required=True,type=Path);p.add_argument('--prepared',required=True,type=Path);p.add_argument('--platform',choices=['android','imageio'],required=True);p.add_argument('--output',required=True,type=Path);a=p.parse_args();results=[]
transforms={2:Image.Transpose.FLIP_LEFT_RIGHT,3:Image.Transpose.ROTATE_180,4:Image.Transpose.FLIP_TOP_BOTTOM,5:Image.Transpose.TRANSPOSE,6:Image.Transpose.ROTATE_270,7:Image.Transpose.TRANSVERSE,8:Image.Transpose.ROTATE_90}
for case in json.load(open(a.fixtures/'photos.json'))['files']:
 name=case['file'];actual=Image.open(a.prepared/(name+'.png')).convert('RGBA');source=Image.open(a.prepared/(name+'.source.png')).convert('RGBA')
 # ImageDecoder honors JPEG/WebP/HEIC orientation; PNG is handled explicitly.
 # ImageIO's complete image API leaves orientation to its caller.
 if (a.platform=='imageio' or name.startswith('png-')) and case['orientation']!=1:source=source.transpose(transforms[case['orientation']])
 assert actual.size==source.size,(name,actual.size,source.size)
 error=max(abs(x-y) for ap,bp in zip(actual.get_flattened_data(),source.get_flattened_data()) for x,y in zip(ap,bp))
 assert error<=1,(name,error)
 results.append({'file':name,'dimensions':actual.size,'maxRGBAChannelError':error})
a.output.write_text(json.dumps({'status':'passed','scope':__doc__,'platform':a.platform,'results':results},indent=2)+'\n');print('PASS native complete decode preservation for',len(results),'prepared photos')
