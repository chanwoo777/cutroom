"""Local dev server for Cutroom.

Serves this folder on 127.0.0.1 with correct MIME types (Windows can map .js to text/plain, which breaks
ES modules) and the same Content-Security-Policy the page declares, sent as a real header so
frame-ancestors also applies. Usage: python serve.py [port]
"""
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8797
CSP = ("default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; "
       "media-src 'self' blob:; font-src 'self'; connect-src 'self' https://huggingface.co https://*.hf.co; worker-src 'self' blob:; "
       "manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'self'")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".html": "text/html; charset=utf-8",
        ".svg": "image/svg+xml",
        ".json": "application/json",
        ".wasm": "application/wasm",
        ".onnx": "application/octet-stream",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s\n" % (fmt % args))


if __name__ == "__main__":
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"Cutroom on http://127.0.0.1:{PORT}")
        httpd.serve_forever()
