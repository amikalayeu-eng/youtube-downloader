#!/bin/sh
set -eu

cat bundle/part*.txt | base64 -d > /tmp/source.tar.gz
tar -xzf /tmp/source.tar.gz -C .
rm -f /tmp/source.tar.gz

python3 - <<'PY'
import base64, glob, pathlib
parts = ''.join(pathlib.Path(p).read_text() for p in sorted(glob.glob('runtime_patch/part*.txt')))
pathlib.Path('/tmp/runtime_patch.tar.gz').write_bytes(base64.b64decode(parts))
PY

tar -xzf /tmp/runtime_patch.tar.gz -C .
rm -f /tmp/runtime_patch.tar.gz

cp -a frontend_override/. frontend/
cp direct_override.py app/direct.py
cp video_fast_override.py app/video_fast.py

python3 -m compileall -q app
python3 -m pip install -r requirements.txt
