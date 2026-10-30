#!/usr/bin/env python3
"""Fake Gemini (generateContent) and Ollama (/api/chat) servers for the assistant tests: the first answer asks for the
tool named in the script, then (when the tool result comes back) a final text quoting the start of that result.
Every request is written to a log.   fakellm.py PORT LOGFILE SCRIPT.json   script: {"tool": "...", "input": {...}, "status": 200}"""
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT, LOG, SCRIPT = int(sys.argv[1]), sys.argv[2], sys.argv[3]


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, body):
        out = json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(out))); self.end_headers()
        self.wfile.write(out)

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        sc = json.load(open(SCRIPT))
        with open(LOG, "a") as f:
            f.write(json.dumps({"path": self.path, "key": self.headers.get("x-goog-api-key", "")[:6], "req": req}) + "\n")
        if sc.get("status", 200) != 200:
            return self.reply(sc["status"], {"error": {"code": sc["status"], "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT"}})
        if ":generateContent" in self.path:                       # Gemini
            last = req["contents"][-1]
            fr = [p["functionResponse"] for p in last.get("parts", []) if "functionResponse" in p]
            if fr:
                r = fr[0].get("response", {})
                text = json.dumps(r.get("result", r))
                parts = [{"text": "Jawab: " + text[:300]}]
            else:
                parts = [{"functionCall": {"name": sc["tool"], "args": sc.get("input", {})}}]
            return self.reply(200, {"candidates": [{"content": {"role": "model", "parts": parts}, "finishReason": "STOP", "index": 0}],
                                    "usageMetadata": {"promptTokenCount": 50, "candidatesTokenCount": 10, "totalTokenCount": 60}})
        if self.path == "/api/chat":                              # Ollama
            last = req["messages"][-1]
            if last["role"] == "tool":
                msg = {"role": "assistant", "content": "Jawab: " + last["content"][:300]}
            else:
                msg = {"role": "assistant", "content": "", "tool_calls": [{"function": {"name": sc["tool"], "arguments": sc.get("input", {})}}]}
            return self.reply(200, {"model": req["model"], "message": msg, "done": True, "prompt_eval_count": 40, "eval_count": 8})
        self.reply(404, {"error": "not found"})


HTTPServer(("127.0.0.1", PORT), H).serve_forever()
