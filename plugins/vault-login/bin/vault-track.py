#!/usr/bin/env python3
"""PostToolUse(Bash) hook: remember which Vaults THIS chat has used, for the status line.

The vault CLI has one global "current" vault, so the chat's own list is built from its
own commands: --dns X when given, otherwise whatever `vault status` says is current.
State: ~/.claude/vault-sessions/<session_id>.json  (most recently used last).
Never blocks or prints: any failure exits 0.
"""
import json
import os
import re
import shlex
import subprocess
import sys
import time

DIR = os.path.join(os.path.expanduser("~"), ".claude", "vault-sessions")
SUBS = {"login", "switch", "query", "api", "mdl", "config"}


def opt(t, name):
    for i, x in enumerate(t):
        if x == name and i + 1 < len(t):
            return t[i + 1]
        if x.startswith(name + "="):
            return x.split("=", 1)[1]
    return None


def status():
    try:
        out = subprocess.run(["vault", "status"], capture_output=True, text=True, timeout=15).stdout
    except Exception:
        return None, None
    dns = re.search(r"^DNS:\s*(\S+)", out, re.M)
    name = re.search(r"^Vault:\s*(.*?)\s*\(ID \d+\)\s*$", out, re.M)
    return (dns.group(1).lower() if dns else None), (name.group(1) if name else None)


def load(p, default):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return default


def save(p, obj):
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, p)


def main():
    d = json.load(sys.stdin)
    if d.get("tool_name") != "Bash":
        return
    sid, cmd = d.get("session_id"), (d.get("tool_input") or {}).get("command") or ""
    if not sid or "vault" not in cmd or not re.fullmatch(r"[\w-]+", sid):
        return
    targets = []
    for seg in re.split(r"&&|\|\||;|\||\n|\$\(|`", cmd):
        try:
            t = shlex.split(seg)
        except ValueError:
            t = seg.split()
        while t and ("=" in t[0] and not t[0].startswith("-") or t[0] in ("sudo", "env", "time", "command", "exec")):
            t = t[1:]
        if len(t) >= 2 and os.path.basename(t[0]) == "vault" and t[1] in SUBS:
            dns = (opt(t, "--dns") or "").lower().removeprefix("https://").rstrip("/")
            targets.append(dns or None)
    if not targets:
        return
    os.makedirs(DIR, exist_ok=True)
    cur_dns, cur_name = status()
    names_p = os.path.join(DIR, "names.json")
    names = load(names_p, {})
    if cur_dns and cur_name:
        names[cur_dns] = cur_name
        save(names_p, names)
    if any(t and t not in names for t in targets):
        try:
            out = subprocess.run(["vault", "list", "--format", "json"], capture_output=True, text=True, timeout=20).stdout
            for v in json.loads(out):
                names[v["dns"].lower()] = v["name"]
            save(names_p, names)
        except Exception:
            pass
    p = os.path.join(DIR, sid + ".json")
    used = load(p, [])
    for dns in targets:
        # cli=True: followed the CLI's current vault (no --dns), so a later `vault switch`
        # elsewhere can leave this chat pointing at a different vault than it expects
        via_cli = dns is None
        dns = dns or cur_dns
        if not dns:
            continue
        name = names.get(dns) or dns.split(".")[0]
        used = [u for u in used if u["dns"] != dns] + [{"dns": dns, "name": name, "ts": int(time.time()), "cli": via_cli}]
    save(p, used[-6:])
    # tidy: drop state of chats untouched for 14 days
    cutoff = time.time() - 14 * 86400
    for f in os.listdir(DIR):
        fp = os.path.join(DIR, f)
        if f != "names.json" and f.endswith(".json") and os.path.getmtime(fp) < cutoff:
            os.remove(fp)


try:
    main()
except Exception:
    pass
sys.exit(0)
