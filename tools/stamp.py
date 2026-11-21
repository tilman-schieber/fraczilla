#!/usr/bin/env python3
"""Cache-bust local asset URLs before deploying.

GitHub Pages lets browsers cache files for 10 minutes, which can mix an old
renderer.js with a new main.js. This appends ?v=<content hash> to every local
.js/.css reference in index.html and in the JS module imports/worker URLs, so a
deploy is always loaded as one consistent set. Run it before committing:

    python3 tools/stamp.py
"""
import hashlib
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = [ROOT / "index.html", *sorted((ROOT / "js").glob("*.js")), ROOT / "css" / "style.css"]
REF = re.compile(r"""(['"])((?:\./|js/|css/)[\w./-]+?\.(?:js|css))(?:\?v=\w+)?\1""")


def unstamped(text):
    return REF.sub(lambda m: f"{m[1]}{m[2]}{m[1]}", text)


digest = hashlib.sha1()
for f in FILES:
    digest.update(unstamped(f.read_text()).encode())
version = digest.hexdigest()[:8]

for f in FILES:
    if f.suffix == ".css":
        continue
    text = f.read_text()
    new = REF.sub(lambda m: f"{m[1]}{m[2]}?v={version}{m[1]}", text)
    if new != text:
        f.write_text(new)
print("stamped", version)
