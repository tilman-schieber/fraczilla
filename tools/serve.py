#!/usr/bin/env python3
"""Local dev server: static files with caching off, so every reload sees the latest modules.

    python3 tools/serve.py [PORT]        (default 8000; localdev passes $PORT)
"""
import http.server
import os
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
http.server.ThreadingHTTPServer(('127.0.0.1', port), NoCache).serve_forever()
