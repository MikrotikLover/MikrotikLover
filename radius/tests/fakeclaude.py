#!/usr/bin/env python3
"""A fake Claude Messages API for the assistant tests: first answer = call the tool named in the script, then (when the
tool result comes back) a final text that quotes the start of that result. Every request is written to a log.
  fakeclaude.py PORT LOGFILE SCRIPT.json    script: {"tool": "top_users_for", "input": {...}, "status": 200}"""
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT, LOG, SCRIPT = int(sys.argv[1]), sys.argv[2], sys.argv[3]


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        sc = json.load(open(SCRIPT))
        with open(LOG, "a") as f:
            f.write(json.dumps({"path": self.path, "beta": self.headers.get("anthropic-beta", ""), "key": (self.headers.get("x-api-key") or self.headers.get("Authorization", "").replace("Bearer ", ""))[:6], "req": req}) + "\n")
        if sc.get("status", 200) != 200:
            self.send_response(sc["status"]); self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(json.dumps({"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}).encode()); return
        last = req["messages"][-1]
        results = [b for b in (last["content"] if isinstance(last["content"], list) else []) if isinstance(b, dict) and b.get("type") == "tool_result"]
        if results:
            c = results[0].get("content")
            text = c if isinstance(c, str) else " ".join(x.get("text", "") for x in c if isinstance(x, dict))
            content, stop = [{"type": "text", "text": "Jawab: " + text[:300]}], "end_turn"
        else:
            content, stop = [{"type": "tool_use", "id": "toolu_01", "name": sc["tool"], "input": sc.get("input", {})}], "tool_use"
        body = {"id": "msg_01", "type": "message", "role": "assistant", "model": req["model"], "content": content,
                "stop_reason": stop, "stop_sequence": None, "usage": {"input_tokens": 100, "output_tokens": 20}}
        out = json.dumps(body).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(out))); self.end_headers()
        self.wfile.write(out)


HTTPServer(("127.0.0.1", PORT), H).serve_forever()
