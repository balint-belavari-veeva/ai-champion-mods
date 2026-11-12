"""
Auth seam for Veeva Vault API calls.

=============================================================================
INTEGRATION POINT — READ BEFORE MODIFYING
=============================================================================
This module is the ONLY place that knows how a request gets authenticated.
Everything else in this skill calls `request()` and stays unaware of the
mechanism.

At time of writing, the intended production path is the Veeva Claude plug-in,
which is expected to inject session credentials. That plug-in is not available
yet, so this module resolves auth in priority order and fails loudly rather
than guessing:

  0. Vault CLI (`vault`) signed in    <- default when no env credentials are set;
     requests go through `vault api` against the CLI's ACTIVE Vault (check it
     with `vault status` first). No session ID is ever read from the CLI.
  1. Plug-in provided credentials  (VEEVA_PLUGIN_SESSION_ID)   <- future path
  2. Explicit session ID           (VAULT_SESSION_ID)          <- works today
  3. Username/password login       (VAULT_USER / VAULT_PASSWORD)

To wire in the real plug-in, implement `_from_plugin()` and nothing else.
=============================================================================
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_API_VERSION = "v26.2"


class VaultAuthError(RuntimeError):
    """Raised when credentials cannot be resolved or are rejected."""


class VaultConfigError(RuntimeError):
    """Raised when required configuration (e.g. VAULT_DNS) is missing."""


def _vault_dns() -> str:
    dns = os.environ.get("VAULT_DNS", "").strip()
    if not dns:
        raise VaultConfigError(
            "VAULT_DNS is not set. Expected the Vault hostname, "
            "e.g. 'myvault.veevavault.com' (no scheme, no trailing slash)."
        )
    return dns.replace("https://", "").replace("http://", "").rstrip("/")


def api_version() -> str:
    return os.environ.get("VAULT_API_VERSION", DEFAULT_API_VERSION)


def _from_plugin():
    """
    PLUG-IN SEAM. Return a session ID string, or None if unavailable.

    Replace the body of this function when the Veeva Claude plug-in ships.
    If the plug-in exposes credentials some other way (a local socket, a
    callback, a mounted token file), that logic belongs here and here only.
    """
    return os.environ.get("VEEVA_PLUGIN_SESSION_ID") or None


def _from_env_session():
    return os.environ.get("VAULT_SESSION_ID") or None


def _from_login():
    """Standard Vault username/password auth. Returns a session ID."""
    user = os.environ.get("VAULT_USER")
    password = os.environ.get("VAULT_PASSWORD")
    if not (user and password):
        return None

    url = f"https://{_vault_dns()}/api/{api_version()}/auth"
    body = urllib.parse.urlencode({"username": user, "password": password}).encode()
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode())
    except urllib.error.URLError as exc:
        raise VaultAuthError(f"Login request to {url} failed: {exc}") from exc

    if payload.get("responseStatus") != "SUCCESS":
        raise VaultAuthError(f"Vault rejected login: {payload}")
    return payload.get("sessionId")


_CACHED_SESSION = None


def session_id() -> str:
    """Resolve a session ID once per process, in documented priority order."""
    global _CACHED_SESSION
    if _CACHED_SESSION:
        return _CACHED_SESSION

    for resolver in (_from_plugin, _from_env_session, _from_login):
        token = resolver()
        if token:
            _CACHED_SESSION = token
            return token

    raise VaultAuthError(
        "No Vault credentials available. Set one of:\n"
        "  VEEVA_PLUGIN_SESSION_ID  (injected by the Veeva Claude plug-in)\n"
        "  VAULT_SESSION_ID         (an existing session ID)\n"
        "  VAULT_USER + VAULT_PASSWORD\n"
        "VAULT_DNS must also be set."
    )


class VaultHTTPError(RuntimeError):
    """Non-2xx response from Vault. Carries the status code for retry logic."""

    def __init__(self, status, url, detail):
        self.status = status
        self.url = url
        self.detail = detail
        super().__init__(f"HTTP {status} from {url}\n{detail}")


def _env_credentials_set() -> bool:
    return any(os.environ.get(k) for k in (
        "VEEVA_PLUGIN_SESSION_ID", "VAULT_SESSION_ID", "VAULT_USER"))


def _use_cli() -> bool:
    """Use the Vault CLI unless the caller supplied explicit credentials."""
    return not _env_credentials_set() and shutil.which("vault") is not None


def _cli_request(path, params, method, form, raw):
    """Same contract as `request`, through `vault api` (the CLI holds the session)."""
    path = path.replace("{version}", api_version())
    if params:
        path = f"{path}?{urllib.parse.urlencode(params)}"
    # Versioned paths (/api/v26.2/...) go as they are; /api/mdl/... has no version,
    # so the CLI must be told not to add one.
    cmd = ["vault", "api", "-i", "-X", method]
    if not re.match(r"^/api/v\d", path):
        cmd[2:2] = ["--api-version", "none"]
    if form is not None:
        cmd += ["-H", "Content-Type: application/x-www-form-urlencoded",
                "-d", urllib.parse.urlencode(form)]
        cmd[cmd.index("-X") + 1] = "POST"
    outfile = None
    if raw:  # the CLI only prints a non-JSON body to a file (-o)
        fd, outfile = tempfile.mkstemp(suffix=".txt")
        os.close(fd)
        cmd += ["-o", outfile]
    cmd.append(path)
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        file_body = open(outfile, errors="replace").read() if outfile else None
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise VaultAuthError(f"`vault api` failed to run: {exc}") from exc
    finally:
        if outfile and os.path.exists(outfile):
            os.remove(outfile)
    # With -o, headers and body both land in the file (we pass -i).
    out = file_body if file_body is not None else proc.stdout
    # -i prints the status line and headers, a blank line, then the body.
    head, sep, body = out.partition("\r\n\r\n")
    if not sep:
        head, sep, body = out.partition("\n\n")
    status = None
    for line in head.splitlines():
        if line.startswith("HTTP/"):
            parts = line.split()
            if len(parts) > 1 and parts[1].isdigit():
                status = int(parts[1])
    if proc.returncode != 0 and status is None:
        raise VaultAuthError(
            "`vault api` failed (not logged in, or no active Vault?). Run "
            f"`vault status`. Detail: {(proc.stderr or out)[:300]}")
    if status is not None and not 200 <= status < 300:
        raise VaultHTTPError(status, path, body[:500])
    return body if raw else json.loads(body)


def request(path: str, params=None, method: str = "GET", form=None, raw=False):
    """
    Make an authenticated Vault API call.

    `path` is relative to the API root and may contain '{version}', which is
    substituted automatically.

    form   -- dict sent as an application/x-www-form-urlencoded body (forces POST)
    raw    -- return the response body as text instead of parsed JSON. Required
              for the MDL endpoints, which return plain-text RECREATE statements.
    """
    if _use_cli():
        return _cli_request(path, params, method, form, raw)
    path = path.replace("{version}", api_version())
    url = f"https://{_vault_dns()}{path}"
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"

    headers = {
        "Authorization": session_id(),
        "Accept": "text/plain" if raw else "application/json",
    }
    body = None
    if form is not None:
        body = urllib.parse.urlencode(form).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        method = "POST"

    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            text = resp.read().decode(errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:500]
        raise VaultHTTPError(exc.code, url, detail) from exc
    except urllib.error.URLError as exc:
        raise VaultAuthError(f"Request to {url} failed: {exc}") from exc

    if raw:
        return text
    return json.loads(text)
