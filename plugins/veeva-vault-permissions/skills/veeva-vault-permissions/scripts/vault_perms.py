#!/usr/bin/env python3
"""
Veeva Vault permission checker with provenance tracing.

Answers two questions in one call:
  1. Does user X have read/edit/create/delete on an object (or field)?
  2. Where does that permission come from?

Output is compact JSON on stdout, designed to be read by an agent without
dumping raw API payloads into context.

Commands
--------
  check     --user <id> --object <name> [--field <name>]
  discover  --user <id> [--grep <substr>]
  profile   --profile <name>

See ../SKILL.md for usage guidance and ../reference/api-endpoints.md for the
underlying API details.
"""

import argparse
import json
import re
import sys

import vault_auth
from vault_auth import VaultAuthError, VaultConfigError, VaultHTTPError

CRUD = ("read", "edit", "create", "delete")


# ---------------------------------------------------------------------------
# Tier 0 — effective permissions. Always available to any authenticated user.
# ---------------------------------------------------------------------------

def fetch_permissions(user_id, name_filter=None):
    """
    GET /api/{version}/objects/users/{id}/permissions

    The published docs declare GET but their own curl example uses POST. We try
    GET and fall back to POST once on 405/404 rather than trusting either.
    """
    path = f"/api/{{version}}/objects/users/{user_id}/permissions"
    params = {"filter": f"name__v::{name_filter}"} if name_filter else None
    try:
        return vault_auth.request(path, params=params, method="GET")
    except VaultHTTPError as exc:
        if exc.status in (404, 405):
            return vault_auth.request(path, params=params, method="POST")
        raise


def effective_permission(user_id, object_name, field_name=None):
    """
    Resolve the effective CRUD flags for an object or field.

    The field-level name__v format is NOT documented by Veeva (the string
    'field_actions' appears nowhere in the developer docs). We therefore try the
    plausible encodings and, if none match, fall back to scanning the unfiltered
    response. Whichever works is reported back in 'resolved_via' so the caller
    learns the real convention for this Vault.
    """
    if field_name is None:
        candidates = [f"object.{object_name}.object_actions"]
    else:
        candidates = [
            f"object.{object_name}.{field_name}.field_actions",
            f"object.{object_name}.{field_name}__v.field_actions",
            f"object.{object_name}.field_actions",
        ]

    for candidate in candidates:
        try:
            payload = fetch_permissions(user_id, candidate)
        except VaultHTTPError:
            continue
        rows = payload.get("data") or []
        if rows:
            return {
                "found": True,
                "name__v": rows[0].get("name__v", candidate),
                "permissions": rows[0].get("permissions", {}),
                "resolved_via": "filter",
                "filter_used": candidate,
            }

    # Nothing matched a guessed filter. Enumerate unfiltered and search.
    payload = fetch_permissions(user_id)
    rows = payload.get("data") or []
    needle = object_name.lower()
    if field_name:
        matches = [
            r for r in rows
            if needle in str(r.get("name__v", "")).lower()
            and field_name.lower() in str(r.get("name__v", "")).lower()
        ]
    else:
        matches = [
            r for r in rows
            if str(r.get("name__v", "")).lower() == f"object.{needle}.object_actions"
        ]

    if matches:
        return {
            "found": True,
            "name__v": matches[0].get("name__v"),
            "permissions": matches[0].get("permissions", {}),
            "resolved_via": "unfiltered_scan",
            "filter_used": None,
        }

    return {
        "found": False,
        "name__v": None,
        "permissions": {},
        "resolved_via": "not_found",
        "filter_used": None,
        "note": (
            "No matching permission entry. Either the user has no grant at all "
            "for this target, or the name__v convention differs in this Vault. "
            "Run 'discover' to list the actual name__v values."
        ),
    }


# ---------------------------------------------------------------------------
# Tier 1 — security profile and its permission sets. Requires Admin rights.
# ---------------------------------------------------------------------------

def fetch_security_profile_name(user_id):
    """Read security_profile__v off the (legacy but simple) user record."""
    payload = vault_auth.request(f"/api/{{version}}/objects/users/{user_id}")
    rows = payload.get("users") or payload.get("data") or []
    if isinstance(rows, list) and rows:
        row = rows[0]
        row = row.get("user") if isinstance(row.get("user"), dict) else row
    elif isinstance(rows, dict):
        row = rows
    else:
        row = payload
    return row.get("security_profile__v") or row.get("security_profile__sys")


def fetch_profile_permission_sets(profile_name):
    """
    GET /api/{version}/configuration/Securityprofile.{name}

    Securityprofile has Describe=Yes and a multi-value 'permission_sets'
    attribute, so this is the documented profile -> permission set link.
    """
    payload = vault_auth.request(
        f"/api/{{version}}/configuration/Securityprofile.{profile_name}"
    )
    data = payload.get("data") or payload
    sets = data.get("permission_sets") or []
    if isinstance(sets, str):
        sets = [s.strip() for s in sets.split(",") if s.strip()]
    return sets, data


# ---------------------------------------------------------------------------
# Tier 2 — permission set contents. Requires Admin + v25.1 for the bulk query.
# Whether the MDL actually carries CRUD grants is UNVERIFIED against a live
# Vault; the code probes and reports rather than assuming.
# ---------------------------------------------------------------------------

def fetch_permission_set_mdl(set_names):
    """
    Bulk-fetch permission set MDL via the Component Definition Query (v25.1+),
    falling back to one Retrieve Component Record (MDL) call per set.

    Returns {set_name: mdl_text}.
    """
    out = {}
    if not set_names:
        return out

    quoted = ", ".join("'" + n.replace("'", "") + "'" for n in set_names)
    vql = (
        "SELECT component_name__v, mdl_definition__v FROM vault_component__v "
        f"WHERE component_type__v = 'Permissionset' AND component_name__v CONTAINS ({quoted})"
    )
    try:
        payload = vault_auth.request(
            "/api/{version}/query/components", form={"q": vql}
        )
        for row in payload.get("data") or []:
            name = row.get("component_name__v")
            if name:
                out[name] = row.get("mdl_definition__v") or ""
        if out:
            return out
    except (VaultHTTPError, VaultAuthError):
        pass  # fall through to per-record MDL

    for name in set_names:
        try:
            out[name] = vault_auth.request(
                f"/api/mdl/components/Permissionset.{name}", raw=True
            )
        except (VaultHTTPError, VaultAuthError):
            continue
    return out


def grants_in_mdl(mdl_text, object_name, field_name=None):
    """
    Scan a permission set's MDL for grants touching this object/field.

    The exact MDL grammar for permission sets is undocumented and varies by
    Vault, so this matches lines mentioning the target rather than parsing a
    schema we cannot verify. Returned as evidence for a human/agent to read,
    never as an authoritative parse.
    """
    if not mdl_text:
        return []
    target = field_name or object_name
    hits = []
    for line in mdl_text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        low = stripped.lower()
        if object_name.lower() in low and (
            field_name is None or field_name.lower() in low
        ):
            hits.append(stripped[:300])
    return hits[:20]


# ---------------------------------------------------------------------------
# Record-level sharing detection
# ---------------------------------------------------------------------------

def object_uses_record_security(object_name):
    """Does this object layer record-level sharing on top of CRUD?"""
    payload = vault_auth.request(
        f"/api/{{version}}/metadata/vobjects/{object_name}"
    )
    data = payload.get("object") or payload.get("data") or payload
    flags = {
        k: data.get(k)
        for k in ("dynamic_security", "secure_sharing_settings", "role_overrides")
        if k in data
    }
    return any(bool(v) for v in flags.values()), flags


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def cmd_check(args):
    result = {
        "user": args.user,
        "object": args.object,
        "field": args.field,
        "effective": None,
        "provenance": {},
        "caveats": [],
        "degraded": [],
    }

    result["effective"] = effective_permission(args.user, args.object, args.field)

    granted = [k for k in CRUD if result["effective"]["permissions"].get(k)]
    result["granted_actions"] = granted

    # Tier 1
    profile = None
    try:
        profile = fetch_security_profile_name(args.user)
        result["provenance"]["security_profile"] = profile
    except (VaultHTTPError, VaultAuthError) as exc:
        result["degraded"].append(
            {"tier": "security_profile", "reason": str(exc)[:200]}
        )

    perm_sets = []
    if profile:
        try:
            perm_sets, _ = fetch_profile_permission_sets(profile)
            result["provenance"]["permission_sets"] = perm_sets
        except (VaultHTTPError, VaultAuthError) as exc:
            result["degraded"].append(
                {"tier": "permission_sets", "reason": str(exc)[:200]}
            )

    # Tier 2
    if perm_sets and not args.no_mdl:
        mdl = fetch_permission_set_mdl(perm_sets)
        attributed = {}
        for name, text in mdl.items():
            hits = grants_in_mdl(text, args.object, args.field)
            if hits:
                attributed[name] = hits
        if attributed:
            result["provenance"]["attributed_to"] = attributed
        elif mdl:
            result["degraded"].append({
                "tier": "grant_attribution",
                "reason": (
                    "Permission set MDL retrieved but contained no lines matching "
                    "this target. Vault may not expose CRUD grants in permission "
                    "set MDL (undocumented). Narrow to the listed permission sets "
                    "manually in the Vault Admin UI."
                ),
            })
        else:
            result["degraded"].append({
                "tier": "grant_attribution",
                "reason": "Could not retrieve permission set MDL (needs Admin rights; bulk query needs v25.1+).",
            })

    # Record-level caveat
    try:
        uses_records, flags = object_uses_record_security(args.object)
        if uses_records:
            result["caveats"].append({
                "type": "record_level_security",
                "detail": (
                    "This object uses record-level sharing, so object/field CRUD "
                    "is not the whole answer. Per-record access also depends on "
                    "object record roles."
                ),
                "flags": flags,
                "next": f"GET /api/{{version}}/vobjects/{args.object}/{{record_id}}/roles",
            })
    except (VaultHTTPError, VaultAuthError) as exc:
        result["degraded"].append(
            {"tier": "record_security_check", "reason": str(exc)[:200]}
        )

    result["caveats"].append({
        "type": "additive_role_permissions",
        "detail": (
            "Application roles can add permissions on top of the security "
            "profile (Vault RN 21R1). If a grant is not explained by the "
            "profile's permission sets, check user_role__sys for the user's "
            "roles and Rolepermissionset for role -> permission set links."
        ),
    })

    return result


def cmd_discover(args):
    """
    Enumerate the actual name__v values for a user.

    This is the empirical answer to Veeva's undocumented field-level naming.
    Run it once per Vault to learn the real convention.
    """
    payload = fetch_permissions(args.user)
    rows = payload.get("data") or []
    names = [r.get("name__v") for r in rows if r.get("name__v")]
    if args.grep:
        needle = args.grep.lower()
        names = [n for n in names if needle in n.lower()]

    shapes = {}
    for n in names:
        shape = re.sub(r"[a-z0-9_]+__[a-z]+", "{name}", n)
        shapes[shape] = shapes.get(shape, 0) + 1

    return {
        "user": args.user,
        "total_entries": len(rows),
        "matched": len(names),
        "distinct_shapes": shapes,
        "sample": names[: args.limit],
    }


def cmd_profile(args):
    sets, raw = fetch_profile_permission_sets(args.profile)
    return {
        "profile": args.profile,
        "permission_sets": sets,
        "active": raw.get("active"),
        "label": raw.get("label"),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    c = sub.add_parser("check", help="check a permission and trace its source")
    c.add_argument("--user", required=True, help="user id, or 'me'")
    c.add_argument("--object", required=True, help="object api name, e.g. product__v")
    c.add_argument("--field", help="field api name (optional)")
    c.add_argument("--no-mdl", action="store_true",
                   help="skip permission set MDL retrieval (faster, less detail)")
    c.set_defaults(func=cmd_check)

    d = sub.add_parser("discover", help="list actual name__v values for a user")
    d.add_argument("--user", required=True)
    d.add_argument("--grep", help="only names containing this substring")
    d.add_argument("--limit", type=int, default=40)
    d.set_defaults(func=cmd_discover)

    p = sub.add_parser("profile", help="list a security profile's permission sets")
    p.add_argument("--profile", required=True)
    p.set_defaults(func=cmd_profile)

    args = parser.parse_args()
    try:
        out = args.func(args)
    except (VaultConfigError, VaultAuthError) as exc:
        json.dump({"error": str(exc)}, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 2
    except VaultHTTPError as exc:
        json.dump(
            {"error": str(exc), "status": exc.status}, sys.stdout, indent=2
        )
        sys.stdout.write("\n")
        return 2

    json.dump(out, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
