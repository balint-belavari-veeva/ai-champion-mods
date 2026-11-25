#!/usr/bin/env python3
"""PreToolUse guard for Bash, active only while the vault-triage skill runs.

Keeps every Vault read-only:
- vault: only GET and VQL (/query) API calls; `vault mdl`, `vault config push|package`
  and unknown subcommands are blocked. The CLI has no --dns on query/api, the target is
  the active Vault, so writes are blocked whichever Vault they would hit.
- curl/wget with a write method against veevavault.com is blocked (VQL POST to /query
  excepted).
- Wrappers are unwrapped and re-checked: bash/sh/zsh -c, eval, xargs, env/sudo/time/
  command/exec/nohup, and $(...) / backtick substitutions.
- Interpreters (python, node, ruby, perl, php) that mention vault / veevavault.com in an
  inline script or a readable script file are blocked: the guard cannot prove what they
  do. Run reads with `vault query` / `vault api` instead.

Exit code 2 + stderr message = block (Claude sees the reason). Backstop, not permission.
"""
import json
import os
import re
import shlex
import sys

WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
VAULT_MENTION = re.compile(r"\bvault\b|veevavault\.com", re.I)
PASSTHROUGH = {"sudo", "env", "time", "command", "exec", "nohup", "nice"}
SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}
VAULT_SUBS = {"login", "logout", "list", "switch", "status", "user", "version",
              "upgrade", "help", "query", "api", "config"}
VQL_PATH = re.compile(r"/query(/components)?/?(\?|$)")


def block(msg):
    print(f"BLOCKED by vault-triage guard: {msg}", file=sys.stderr)
    sys.exit(2)


def opt(tokens, *names):
    for i, t in enumerate(tokens):
        for n in names:
            if t == n and i + 1 < len(tokens):
                return tokens[i + 1]
            if t.startswith(n + "="):
                return t.split("=", 1)[1]
    return None


def vault_sub_and_rest(tokens):
    """First positional after global flags (skips --api-version's value)."""
    i, n = 1, len(tokens)
    while i < n:
        t = tokens[i]
        if t == "--api-version":
            i += 2
            continue
        if t.startswith("-"):
            i += 1
            continue
        return t, tokens[i + 1:]
    return None, []


def check_vault(tokens):
    sub, rest = vault_sub_and_rest(tokens)
    if sub is None:
        return
    if sub == "mdl":
        block("'vault mdl' executes statements and is not allowed. Read components with "
              "`vault api --api-version none /api/mdl/components/<Type>.<name> -o <file>`.")
    if sub not in VAULT_SUBS:
        block(f"'vault {sub}' is not on the read-only vault allowlist.")
    if sub == "config":
        action = next((t for t in rest if not t.startswith("-")), "")
        if action in ("push", "package"):
            block(f"'vault config {action}' writes to a Vault. Triage is read-only: "
                  "describe the change in the write-up instead.")
    elif sub == "api":
        method = (opt(rest, "-X", "--method") or "").upper()
        has_body = any(t in ("-d", "--data", "-F", "--form") or t.startswith(("--data=", "--form="))
                       for t in rest)
        if not method:
            method = "POST" if has_body else "GET"
        path = next((t for t in rest if t.startswith("/")), "")
        if method != "GET" and not (method == "POST" and VQL_PATH.search(path)):
            block(f"vault api {method} {path or '(no path)'} is a write. Triage is read-only; "
                  "only GET and VQL (/query) are allowed.")


def check_curl(tokens):
    joined = " ".join(tokens)
    if "veevavault.com" not in joined:
        return
    method = (opt(tokens, "-X", "--request") or "").upper()
    has_body = any(t in ("-d", "--data", "--data-raw", "--data-binary", "-F", "--form", "-T")
                   or t.startswith(("--data=", "--form=")) for t in tokens)
    if method in WRITE_METHODS or (has_body and method != "GET"):
        if method in ("", "POST") and VQL_PATH.search(joined):
            return  # VQL
        block("curl/wget write against a Vault host. Use `vault query` / `vault api` "
              "so the guard can check it.")


# Bundled scripts verified read-only (GET calls and VQL only). The interpreter check cannot
# read them as safe because they mention vault, so allow them by exact path tail.
READONLY_SCRIPTS = (
    os.sep.join(["veeva-vault-permissions", "scripts", "vault_perms.py"]),
)


def is_bundled_readonly_script(tokens):
    for t in tokens[1:]:
        if not t.startswith("-") and os.path.isfile(t):
            if os.path.realpath(t).endswith(READONLY_SCRIPTS):
                return True
    return False


def check_interpreter(tokens):
    if is_bundled_readonly_script(tokens):
        return
    texts = []
    for i, t in enumerate(tokens[1:], 1):
        if t in ("-c", "-e", "-r", "--eval", "-p") and i + 1 < len(tokens):
            texts.append(tokens[i + 1])
        elif not t.startswith("-") and os.path.isfile(t):
            try:
                with open(t, "r", errors="ignore") as fh:
                    texts.append(fh.read(200000))
            except OSError:
                pass
    if any(VAULT_MENTION.search(x) for x in texts):
        block(f"'{tokens[0]}' script references Vault. The guard cannot verify it is "
              "read-only. Use `vault query` / `vault api` directly.")


def split_segments(command):
    """Split on unquoted ; & | newline so quoted scripts stay in one piece."""
    parts, cur, quote, i = [], [], None, 0
    while i < len(command):
        ch = command[i]
        if quote:
            cur.append(ch)
            if ch == quote:
                quote = None
            elif ch == "\\" and quote == '"' and i + 1 < len(command):
                cur.append(command[i + 1])
                i += 1
        elif ch in ("'", '"'):
            quote = ch
            cur.append(ch)
        elif ch in ";&|\n":
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
        i += 1
    parts.append("".join(cur))
    return [p.strip() for p in parts if p.strip()]


def substitutions(command):
    """Contents of $(...) and `...` (these execute even inside double quotes)."""
    found = re.findall(r"\$\(([^()]*)\)", command)
    found += re.findall(r"`([^`]*)`", command)
    return found


def check_command(command, depth=0):
    if depth > 4:
        block("command nesting too deep to verify.")
    for sub in substitutions(command):
        check_command(sub, depth + 1)
    for part in split_segments(command):
        try:
            toks = shlex.split(part)
        except ValueError:
            toks = part.split()
        while toks and (("=" in toks[0] and not toks[0].startswith("-"))
                        or toks[0].rsplit("/", 1)[-1] in PASSTHROUGH):
            toks = toks[1:]
        if not toks:
            continue
        exe = toks[0].rsplit("/", 1)[-1]
        if exe == "vault":
            check_vault(toks)
        elif exe in ("curl", "wget"):
            check_curl(toks)
        elif exe in SHELLS:
            inner = opt(toks, "-c")
            if inner is None:
                for i, t in enumerate(toks):
                    if t.startswith("-") and "c" in t[1:] and not t.startswith("--") and i + 1 < len(toks):
                        inner = toks[i + 1]
                        break
            if inner:
                check_command(inner, depth + 1)
        elif exe == "eval":
            check_command(" ".join(toks[1:]), depth + 1)
        elif exe == "xargs":
            rest = [t for t in toks[1:] if not t.startswith("-")]
            if rest:
                check_command(" ".join(rest), depth + 1)
        elif re.match(r"^(python[\d.]*|node|ruby|perl|php)$", exe):
            check_interpreter(toks)


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    if data.get("tool_name") != "Bash":
        return
    check_command(data.get("tool_input", {}).get("command", ""))


if __name__ == "__main__":
    main()
