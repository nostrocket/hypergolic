"""Nonce-scoped local HTTP/WebSocket receiver; no app or browser interception."""
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import time

class Receiver:
    def __init__(self):
        self.receipts=[]
        owner=self
        class Handler(BaseHTTPRequestHandler):
            protocol_version='HTTP/1.1'
            def do_GET(self):
                websocket=self.headers.get('Upgrade','').lower()=='websocket'
                owner.receipts.append({'path':self.path,'transport':'websocket' if websocket else 'http',
                                       'monotonic':time.monotonic()})
                if websocket:
                    key=self.headers.get('Sec-WebSocket-Key','')
                    accept=base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
                    self.send_response(101)
                    self.send_header('Upgrade','websocket')
                    self.send_header('Connection','Upgrade')
                    self.send_header('Sec-WebSocket-Accept',accept)
                    self.end_headers()
                else:
                    body=b'local-receiver-control\n'
                    self.send_response(200)
                    self.send_header('Content-Length',str(len(body)))
                    self.send_header('Connection','close')
                    self.send_header('Access-Control-Allow-Origin','*')
                    self.end_headers()
                    self.wfile.write(body)
                self.close_connection=True
            def log_message(self,*args):
                pass
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.port=self.server.server_port
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)
    def __enter__(self):
        self.thread.start()
        return self
    def __exit__(self,*_):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
