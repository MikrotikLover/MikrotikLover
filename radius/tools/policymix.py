#!/usr/bin/env python3
"""Several policies for one user: the server joins them into one policy ("mix-…").

A router gives a logged-in user ONE address list (Mikrotik-Address-List), so a user with the policies
students + no-video is put in the list of a joined policy, policy-mix-<hash>, made from both:
  - every block / block-app / block-site / block-word / block-all / block-vpn line of every policy
    (each with its own time=);
  - every exception (allow-site / allow-web / allow-app / allow-only) of any policy — an exception was
    always stronger than a block;
  - dns: the strictest one asked for; strict-ech when any policy has it.
A policy that is turned off is left out; a deleted one too. Users with the same set share one mix.
The mixes live in POLICY_DIR/mix/ (not shown as policies of their own); the server makes them again
on every router build, so editing a policy changes every mix it is in.

  policymix.py name a,b,c                         -> mix-xxxxxxxxxx (same set = same name)
  policymix.py write --dir POLICY_DIR a,b,c       -> writes POLICY_DIR/mix/<name>.txt, prints the name
  policymix.py regen --dir POLICY_DIR [USED...]   -> remakes the used mixes, removes the others
  policymix.py members --dir POLICY_DIR NAME      -> a,b,c
"""
import hashlib, os, re, sys

NAME_RE = re.compile(r"^[a-z0-9-]{1,40}$")
# strictest last
DNS_RANK = {"router": 0, "cleanbrowsing-adult": 1, "family": 2, "adguard-family": 3, "cleanbrowsing-family": 4}
HEAD = "# mix: "


def members_of(spec):
    """'a,b , a' -> ['a', 'b'] (order kept, no repeats); ValueError for a bad name"""
    out = []
    for p in re.split(r"[,\s+]+", spec or ""):
        if not p:
            continue
        if not NAME_RE.match(p) or p.startswith("mix-"):
            raise ValueError(f"bad policy name '{p}'")
        if p not in out:
            out.append(p)
    return out


def mix_name(members):
    return "mix-" + hashlib.sha1(",".join(sorted(members)).encode()).hexdigest()[:10]


def merge(texts, members):
    """texts: {policy: file text}; members in the user's order -> the joined policy file"""
    desc, lines, dns, ech = [], [], "router", False
    for m in members:
        t = texts.get(m)
        if t is None:
            continue
        first = True
        for raw in t.splitlines():
            s = raw.strip()
            if first and s.startswith("#"):
                desc.append(s.lstrip("# ").strip())
            first = False
            if not s or s.startswith("#"):
                continue
            s = re.sub(r"\s+", " ", s.split("#", 1)[0]).strip()     # a comment after a rule (build.sh drops it too)
            if not s:
                continue
            word = s.split(" ", 1)[0]
            if word == "dns":
                d = s.split(" ", 1)[1].strip() if " " in s else "router"
                if DNS_RANK.get(d, 0) > DNS_RANK.get(dns, 0):
                    dns = d
                continue
            if word == "strict-ech":
                ech = True
                continue
            if s not in lines:
                lines.append(s)
    out = [f"# {' + '.join(members)} (joined: " + "; ".join(d for d in desc if d)[:300] + ")",
           f"{HEAD}{','.join(members)}"]
    out += lines
    if dns != "router":
        out.append(f"dns {dns}")
    if ech:
        out.append("strict-ech")
    return "\n".join(out) + "\n"


def _off(policy_dir):
    try:
        return {l.strip() for l in open(os.path.join(policy_dir, ".off"), encoding="utf-8") if l.strip()}
    except OSError:
        return set()


def write(policy_dir, members):
    """(re)make the mix file of these members; returns its name"""
    off = _off(policy_dir)
    texts = {}
    for m in members:
        if m in off:
            continue
        try:
            texts[m] = open(os.path.join(policy_dir, m + ".txt"), encoding="utf-8").read()
        except OSError:
            pass
    name = mix_name(members)
    d = os.path.join(policy_dir, "mix")
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, f".{name}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(merge(texts, members))
    os.replace(tmp, os.path.join(d, name + ".txt"))
    return name


def members(policy_dir, name):
    try:
        for line in open(os.path.join(policy_dir, "mix", name + ".txt"), encoding="utf-8"):
            if line.startswith(HEAD):
                return members_of(line[len(HEAD):])
    except OSError:
        pass
    return []


def regen(policy_dir, used):
    """remake every used mix from its policies' current text; remove the unused ones"""
    d = os.path.join(policy_dir, "mix")
    kept = []
    if os.path.isdir(d):
        for f in os.listdir(d):
            if not f.endswith(".txt"):
                continue
            name = f[:-4]
            if name in used:
                ms = members(policy_dir, name)
                if ms:
                    write(policy_dir, ms)
                    kept.append(name)
                    continue
            os.unlink(os.path.join(d, f))
    return kept


def main(argv):
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    what, rest = argv[1], argv[2:]
    pdir = "/var/lib/mikrotiklover/policies"
    if rest[:1] == ["--dir"]:
        pdir, rest = rest[1], rest[2:]
    try:
        if what == "name":
            print(mix_name(members_of(" ".join(rest))))
        elif what == "write":
            ms = members_of(" ".join(rest))
            if len(ms) < 2:
                raise ValueError("a mix needs two policies or more")
            print(write(pdir, ms))
        elif what == "regen":
            print(" ".join(regen(pdir, set(rest))))
        elif what == "members":
            print(",".join(members(pdir, rest[0] if rest else "")))
        else:
            raise ValueError(f"unknown command {what}")
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
