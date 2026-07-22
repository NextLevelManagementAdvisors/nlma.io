#!/usr/bin/env python3
import os, hmac, hashlib, time, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
WHSEC=os.environ["STRIPE_WHSEC"].strip()
FORWARD="http://127.0.0.1:5678/webhook/consult-paid"
TOLERANCE=600
def verify(raw, sig):
    if not sig: return False
    kvs=[x.split("=",1) for x in sig.split(",") if "=" in x]
    d=dict(kvs); t=d.get("t")
    if not t: return False
    try:
        if abs(time.time()-int(t))>TOLERANCE: return False
    except: return False
    expected=hmac.new(WHSEC.encode(), t.encode()+b"."+raw, hashlib.sha256).hexdigest()
    return any(k=="v1" and hmac.compare_digest(expected,v) for k,v in kvs)
class H(BaseHTTPRequestHandler):
    def _s(self,c,b=b""):
        self.send_response(c); self.send_header("Content-Type","application/json")
        self.send_header("Content-Length",str(len(b))); self.end_headers()
        if b: self.wfile.write(b)
    def do_POST(self):
        n=int(self.headers.get("Content-Length","0") or 0)
        raw=self.rfile.read(n); sig=self.headers.get("Stripe-Signature","")
        if not verify(raw,sig): self._s(400,b'{"error":"invalid_signature"}'); return
        try:
            req=urllib.request.Request(FORWARD,data=raw,method="POST",headers={"Content-Type":"application/json"})
            urllib.request.urlopen(req,timeout=60).read()
            self._s(200,b'{"received":true}')
        except Exception:
            self._s(500,b'{"error":"forward_failed"}')  # 5xx => Stripe retries a VERIFIED event
    def log_message(self,*a): pass
if __name__=="__main__":
    HTTPServer(("127.0.0.1",3071),H).serve_forever()
