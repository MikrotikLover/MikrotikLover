"""Build synthetic IPFIX / NetFlow v9 packets for the collector tests."""
import socket, struct

# template: src4 dst4 sport dport proto bytes pkts natsrc4 natdst4 flowStartMs flowEndMs
FIELDS = [(8, 4), (12, 4), (7, 2), (11, 2), (4, 1), (1, 8), (2, 8), (225, 4), (226, 4), (152, 8), (153, 8)]
FMT = "!4s4sHHBQQ4s4sQQ"

def rec(src, dst, sp, dp, nbytes, nsrc="0.0.0.0", ndst="0.0.0.0", start=1000, end=2000, proto=6):
    a = socket.inet_aton
    return struct.pack(FMT, a(src), a(dst), sp, dp, proto, nbytes, nbytes // 1400 + 1, a(nsrc), a(ndst), start, end)

def ipfix(records, with_template=True, tid=256):
    sets = b""
    if with_template:
        t = struct.pack("!HH", tid, len(FIELDS)) + b"".join(struct.pack("!HH", *f) for f in FIELDS)
        sets += struct.pack("!HH", 2, 4 + len(t)) + t
    body = b"".join(records)
    sets += struct.pack("!HH", tid, 4 + len(body)) + body
    return struct.pack("!HHIII", 10, 16 + len(sets), 0, 1, 0) + sets

def v9(records, tid=300):
    t = struct.pack("!HH", tid, len(FIELDS)) + b"".join(struct.pack("!HH", *f) for f in FIELDS)
    body = b"".join(records)
    sets = struct.pack("!HH", 0, 4 + len(t)) + t + struct.pack("!HH", tid, 4 + len(body)) + body
    return struct.pack("!HHIIII", 9, 2, 0, 0, 1, 7) + sets

