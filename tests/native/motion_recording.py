"""Bounded native screen recording around actual input; never synthesizes frames."""
import hashlib
import subprocess
import time
import uuid
from driver import CheckFailed


def record_native_motion(driver,name,action):
    remote='/sdcard/hypergolic-motion-'+uuid.uuid4().hex+'.mp4'
    output=driver.out/(name+'.mp4')
    if output.exists():raise CheckFailed('Refusing to overwrite motion evidence')
    started=time.monotonic()
    recorder=subprocess.Popen([driver.adb,'-s',driver.args.serial,'shell','screenrecord','--time-limit','6','--bit-rate','4000000',remote],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        deadline=time.monotonic()+3
        while True:
            if recorder.poll() is not None:raise CheckFailed('Native screen recorder ended before input')
            try:
                driver.adb_run('shell','stat','-c','%s',remote,timeout=3)
                break
            except CheckFailed:
                if time.monotonic()>deadline:raise CheckFailed('Native screen recorder did not create its owned output')
                time.sleep(.1)
        # Recorded lead-in gives visual reviewers a settled frame before input.
        time.sleep(.4)
        input_offset=time.monotonic()-started
        action()
        stdout,stderr=recorder.communicate(timeout=12)
        if recorder.returncode:raise CheckFailed('Native screen recording failed: '+stderr.decode(errors='replace')[:500])
        data=driver.adb_run('exec-out','cat',remote,binary=True,timeout=15)
        if len(data)<1024 or data[4:8]!=b'ftyp':raise CheckFailed('Native screen recording did not produce a valid MP4 header')
        output.write_bytes(data)
        driver.result.setdefault('videos',[]).append({'name':name,'file':output.name,'sha256':hashlib.sha256(data).hexdigest(),
          'bytes':len(data),'inputOffsetFromLocalStartSeconds':input_offset,'nativeTimeLimitSeconds':6,
          'capture':'Android screenrecord around actual ADB input','visuallyInspected':False,
          'timingLimit':'Local offset is an alignment hint, not native presentation-time/frame-pacing proof'})
    finally:
        if recorder.poll() is None:
            try:recorder.communicate(timeout=8)
            except subprocess.TimeoutExpired:recorder.terminate();recorder.communicate(timeout=3)
        driver.adb_run('shell','rm','--',remote,check=False,timeout=10)
