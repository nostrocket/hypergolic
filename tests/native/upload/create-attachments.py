#!/usr/bin/env python3
"""Independent real WAV, H.264 MP4, PDF, ZIP and UTF-8 fixtures; no user files."""
import argparse,hashlib,io,json,math,struct,subprocess,wave,zipfile
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=Path,required=True);args=p.parse_args()
args.output.mkdir(parents=True,exist_ok=False)
output=args.output
stream=io.BytesIO()
with wave.open(stream,'wb') as audio:
    audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(8000)
    audio.writeframes(b''.join(struct.pack('<h',int(12000*math.sin(2*math.pi*440*n/8000))) for n in range(2000)))
audio=stream.getvalue();private=b'INFOICMT'+struct.pack('<I',20)+b'Fixture comment only';chunk=b'LIST'+struct.pack('<I',len(private))+private
(output/'fixture.wav').write_bytes(audio[:4]+struct.pack('<I',len(audio)-8+len(chunk))+audio[8:]+chunk)
(output/'fixture.txt').write_bytes(b'Independent selected attachment.\nMetadata remains unchanged.\n')
with zipfile.ZipFile(output/'fixture.zip','w',zipfile.ZIP_DEFLATED) as archive:
    info=zipfile.ZipInfo('fixture.txt',(2026,1,2,3,4,6));archive.writestr(info,b'Public generated attachment.\n');archive.comment=b'Unchanged fixture metadata'
objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>']
content=b'BT /F1 14 Tf 10 50 Td (Public upload fixture) Tj ET\n'
objects += [b'<< /Length '+str(len(content)).encode()+b' >>\nstream\n'+content+b'endstream',b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
pdf=b'%PDF-1.4\n';offsets=[]
for index,body in enumerate(objects,1):offsets.append(len(pdf));pdf+=str(index).encode()+b' 0 obj\n'+body+b'\nendobj\n'
xref=len(pdf);pdf+=b'xref\n0 6\n0000000000 65535 f \n'+b''.join(f'{n:010} 00000 n \n'.encode() for n in offsets)+b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+str(xref).encode()+b'\n%%EOF\n';(output/'fixture.pdf').write_bytes(pdf)
subprocess.run(['swiftc','-swift-version','6','-warnings-as-errors','-parse-as-library',str(Path(__file__).with_name('create-video.swift')),'-o',str(output/'video-generator')],check=True)
subprocess.run([str(output/'video-generator'),str(output/'fixture.mp4')],check=True)
types={'wav':'audio/wav','mp4':'video/mp4','pdf':'application/pdf','zip':'application/zip','txt':'text/plain'}
files=[]
for extension,mime in types.items():
    filename='fixture.'+extension;data=(output/filename).read_bytes();files.append({'file':filename,'mimeType':mime,'size':len(data),'sha256':hashlib.sha256(data).hexdigest()})
(output/'attachments.json').write_text(json.dumps({'files':files,'metadataPolicy':'attachment-unchanged'},indent=2)+'\n');print(json.dumps(files))
