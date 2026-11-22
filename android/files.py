#!/usr/bin/env python3
"""Tiny download server for the J2ME app (FbClient.jad/.jar), e.g. port 8090.

Phones install over the air from the .jad link, which only works when the
server sends the J2ME MIME types.

  files.py <port> <dir>
"""
import functools
import http.server
import os
import sys

port, root = int(sys.argv[1]), sys.argv[2]


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map)
    extensions_map.update({
        '.jad': 'text/vnd.sun.j2me.app-descriptor',
        '.jar': 'application/java-archive',
        '.html': 'text/html; charset=utf-8',
    })

    def send_head(self):
        # BlackBerry refuses the Nokia build: the same link gives it its own.
        ua = self.headers.get('User-Agent', '')
        if 'BlackBerry' in ua and self.path.split('?')[0] in ('/FbClient.jad', '/FbClient.jar'):
            bb = self.path.split('?')[0].replace('FbClient', 'FbClient-bb', 1)
            if os.path.isfile(os.path.join(self.directory, bb.lstrip('/'))):
                self.path = bb
        return super().send_head()

    def end_headers(self):
        # Always the newest build, never a cached one.
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


http.server.ThreadingHTTPServer.allow_reuse_address = True
server = http.server.ThreadingHTTPServer(('0.0.0.0', port), functools.partial(Handler, directory=root))
print('files: serving %s on :%d' % (root, port), flush=True)
server.serve_forever()
