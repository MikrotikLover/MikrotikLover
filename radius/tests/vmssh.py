#!/usr/bin/env python3
"""SSH into the test VM with a password (tests only; no pexpect needed). The first login answers the forced password
change, the second runs the commands as root (sudo) and prints each one's output.
   vmssh.py PORT USER PASSWORD NEWPASSWORD 'command' ..."""
import os
import pty
import re
import select
import sys
import time

port, user, pw, newpw, cmds = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:]


class Session:
    def __init__(self):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.execvp("ssh", ["ssh", "-tt", "-p", port, "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
                              "-o", "PubkeyAuthentication=no", "-o", "LogLevel=ERROR", f"{user}@127.0.0.1"])
        self.buf = ""

    def expect(self, pattern, timeout=120):
        end = time.time() + timeout
        while time.time() < end:
            m = re.search(pattern, self.buf, re.I | re.S)
            if m:
                self.buf = self.buf[m.end():]
                return m
            r, _, _ = select.select([self.fd], [], [], 1)
            if r:
                try:
                    data = os.read(self.fd, 4096)
                except OSError:
                    break
                if not data:
                    break
                self.buf += data.decode(errors="replace")
        return None

    def send(self, s):
        os.write(self.fd, (s + "\n").encode())

    def close(self):
        try:
            os.kill(self.pid, 9)
            os.waitpid(self.pid, 0)
        except OSError:
            pass


s = Session()
asked = False
if s.expect(r"password:") and (s.send(pw) or True) and s.expect(r"current password:") and (s.send(pw) or True) \
        and s.expect(r"new password:") and (s.send(newpw) or True) and s.expect(r"retype new password:"):
    s.send(newpw)
    asked = True                       # the system asked for a new password before letting us in
    s.expect(r"updated successfully", 60)
s.close()
time.sleep(2)
s = Session()
if not (s.expect(r"password:") and (s.send(newpw) or True) and s.expect(r"\$ $|\$ ", 120)):
    print("LOGIN-FAILED")
    sys.exit(1)
# the change was asked for, and the new password is the one that works now
print("CHANGED" if asked else "NOT-CHANGED")
s.send("sudo -S -p 'SUDO''-PW:' true")          # the quotes keep the typed line from matching the prompt
if s.expect(r"SUDO-PW:", 20):
    s.send(newpw)
s.expect(r"\$ ", 20)
for i, c in enumerate(cmds):
    s.send(f"echo ==CMD{i}==; sudo {c} 2>&1; echo ==END{i}==")
    s.expect(rf"==CMD{i}==\r?\n", 120)
    m = s.expect(rf"(.*?)==END{i}==", 300)
    print(f"--- {i}\n" + (m.group(1).replace("\r", "") if m else "(no output)"))
s.send("exit")
s.close()
