---
name: veeva-vault-permissions
description: Check whether a Veeva Vault user has read/edit/create/delete access to an object or field, and trace which security profile and permission sets grant it. Use for questions like "can user X edit product__v", "why does this user have access to this field", "where does this permission come from", "who granted this", Vault access troubleshooting, or auditing Vault permissions.
---

# Veeva Vault permission checks and provenance

Answers two questions about a Veeva Vault user:

1. **Effective access** — does this user have read/edit/create/delete on an object or field?
2. **Provenance** — which security profile and permission set(s) grant it?

## Run this first

```bash
python3 <this skill's folder>/scripts/vault_perms.py \
  check --user <id> --object <object__v> [--field <field__v>]
```

`<this skill's folder>` is the directory containing this SKILL.md; always pass the
script's full absolute path. The script works from any working directory. Shorthand
below omits the path for readability.

**Target first.** The script reads the *active* Vault of the signed-in `vault` CLI.
Run `vault status`, confirm it is the Vault you mean, and say which Vault the answer
is for. Not signed in: `vault login --dns <DNS>` (the user runs it; never ask for
passwords or tokens in chat).

`--user` accepts a user ID or the literal `me`. Output is compact JSON. **Read the
JSON and summarise it — do not paste it back to the user verbatim.**

Other commands:

```bash
# Learn this Vault's real name__v convention (see "Known unknowns" below)
python3 scripts/vault_perms.py discover --user <id> --grep <object_name>

# List a security profile's permission sets
python3 scripts/vault_perms.py profile --profile business_admin__v
```

## Reading the output

| Key | Meaning |
|---|---|
| `effective.permissions` | The authoritative CRUD answer. Trust this. |
| `granted_actions` | Convenience list of the `true` actions. |
| `provenance.security_profile` | The user's one security profile. |
| `provenance.permission_sets` | Permission sets in that profile. **Reliable floor.** |
| `provenance.attributed_to` | Specific sets whose MDL mentions the target. **Evidence, not proof.** |
| `degraded` | Tiers that failed, and why. Always report these. |
| `caveats` | Conditions that make the CRUD answer incomplete. |

### Report degradation honestly

The tiers fail independently. If `degraded` contains an entry, say so rather than
implying a complete trace. The common cause is **insufficient privilege**: the
`/configuration/` and `/api/mdl/` endpoints require Admin rights, so a
low-privilege caller gets a correct effective answer with no provenance. That is
expected behaviour, not a bug — tell the user they need an Admin session to trace
the source.

### `attributed_to` is evidence, not proof

Permission set MDL grammar is undocumented and varies by Vault, so the script
matches lines mentioning the target rather than parsing a verified schema. Present
these as "permission set X appears to grant this" and cite the matched line. Never
state attribution as certain fact.

## Token discipline

This skill exists so agents stop exploring the Vault API ad hoc. Follow these:

- **Always filter.** The permissions endpoint returns every permission for a user
  when unfiltered — potentially thousands of rows. The script filters by default.
- **Never `discover` without `--grep`** unless you specifically need the full shape
  census. It is the one command that can return a large payload.
- **Use `--no-mdl`** when the user only asked "do they have access" and not "why".
  It skips the whole Tier 2 fetch.
- **One `check` call answers both questions.** Do not chain manual curl calls to
  re-derive what the script already returned.

## Known unknowns — do not paper over these

Three things are genuinely undocumented by Veeva. The script handles each, but you
should be honest when they surface.

1. **Field-level `name__v` format is undocumented.** The string `field_actions`
   appears nowhere in Veeva's developer docs. The parameter template reads
   `object.{object name}.{object|field}_actions`, which implies a two-segment form
   with no field-name slot. The script tries several encodings, then falls back to
   scanning unfiltered results, and reports which worked in `resolved_via`. If
   `resolved_via` is `unfiltered_scan`, mention that the field convention was
   determined empirically. Run `discover` to confirm the convention for a Vault.

2. **Whether permission set MDL contains CRUD grants is unverified.** Strong
   indirect evidence says yes; there is no published example. If
   `attributed_to` is absent but `permission_sets` is present, the honest answer is
   "the permission comes from one of these N sets — narrow it in the Admin UI."

3. **No precedence rule is documented.** Veeva never states whether grants are
   additive, whether most-restrictive wins, or whether permission sets are capped
   by the application license. The single confirmed statement (RN 21R1) is that
   application-role permissions are assigned *in addition to* security profile
   permissions. **Do not invent a precedence rule.** If a user has access that the
   profile's permission sets do not explain, check the role path rather than
   guessing.

## Two traps

**Security Policy ≠ Security Profile.** `/objects/securitypolicies` governs
passwords and authentication. It has nothing to do with access grants. Ignore it
for permission questions.

**Object/field CRUD is not the whole story.** For objects with `dynamic_security`
or `secure_sharing_settings`, per-record access also depends on object record
roles. The script flags this as a `record_level_security` caveat. When it appears,
tell the user the CRUD answer is necessary but not sufficient for any specific
record, and point at
`GET /api/{version}/vobjects/{object}/{record_id}/roles`.

## Setup

Default: the `vault` CLI, signed in (`vault status`). The script calls `vault api`
against the CLI's active Vault and never reads a session ID out of the CLI. No other
setup, `VAULT_DNS` is not needed.

Override (CI or no CLI): set explicit credentials and `VAULT_DNS`, resolved in order:
1. `VEEVA_PLUGIN_SESSION_ID` (reserved seam, `vault_auth.py::_from_plugin()`)
2. `VAULT_SESSION_ID`: an existing session ID
3. `VAULT_USER` + `VAULT_PASSWORD`: standard login

Any of these set means the CLI is skipped. `VAULT_API_VERSION` defaults to `v26.2`.

## Falling back to raw API calls

`reference/api-endpoints.md` documents every verified endpoint, the response
shapes, the security model chain, and what is *not* retrievable. Consult it when
the script hits a case it does not cover — but prefer fixing the script over
one-off curl calls, so the next agent benefits.
