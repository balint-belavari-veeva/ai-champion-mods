# Veeva Vault REST API — permission-related endpoints (v26.2)

Verified against `general.veevavault.dev` API reference, version 26.2.
Every endpoint below was read from the published docs. Items marked
**UNVERIFIED** could not be confirmed and must not be relied on without testing.

---

## 1. Retrieve User Permissions  *(the primary endpoint)*

```
GET /api/{version}/objects/users/{id}/permissions
```

| Part | Detail |
|---|---|
| `{id}` | User ID, or the literal `me` for the session user |
| `filter` | `name__v::{permission_name}` — **wildcards are NOT supported** |
| `Accept` | `application/json` (default) or `application/xml` |

`{permission_name}` format: `object.{object_name}.{object_or_field}_actions`

Response:

```json
{
  "responseStatus": "SUCCESS",
  "data": [
    {
      "name__v": "object.product__v.object_actions",
      "permissions": { "read": true, "edit": true, "create": false, "delete": false }
    }
  ]
}
```

Per the docs this returns "all object and object field permissions (Read, Edit,
Create, Delete) assigned to a specific user" — so both levels are covered.

> **Doc bug — method mismatch.** The page declares the method as `GET`, but its
> own curl example uses `-X POST`. The same contradiction appears on the sibling
> "Retrieve My User Permissions" page. Use `GET`; if a Vault rejects it, retry
> once as `POST` before reporting failure.

Sibling: `GET /api/{version}/objects/users/me/permissions` — identical shape,
scoped to the caller.

---

## 2. Retrieve User

```
GET /api/{version}/objects/users/{id}
```

Optional query params `exclude_vault_membership`, `exclude_app_licensing`
(booleans; set `false` to *include* those groups — they are excluded by default).

Relevant response fields:

```json
"security_policy_id__v": 1000181,
"security_profile__v": "vault_owner__v",
"license_type__v": "full__v",
"is_domain_admin__v": false,
"active__v": true,
"domain_active__v": true
```

**This does NOT list the user's assigned permission sets.** Only the single
security profile name is exposed.

> Docs note this is the legacy domain-level user endpoint. Since v18.1 admins
> manage users as `user__sys` object records, and the docs recommend
> `GET /api/{version}/vobjects/user__sys/{id}` instead.

Standard security profile values (from `GET /api/{version}/metadata/objects/users`):
`business_admin__v`, `document_user__v`, `external_user__v`, `read_only_user__v`,
`system_admin__v`, `vault_owner__v`, `view_based_user__v`.

---

## 3. Object record roles — a SEPARATE access layer

```
GET /api/{version}/vobjects/{object_name}/{id}/roles{/role_name}
```

Returns which users/groups hold roles (`owner__v`, `viewer__v`, `editor__v`, or
custom) **on one specific record**. This is record-level sharing, layered on top
of the object/field CRUD permissions from §1.

A complete "can user X do Y" answer needs this layer too **when** the object has
`secure_sharing_settings` or `dynamic_security` enabled — check via
`GET /api/{version}/metadata/vobjects/{object_name}`.

Documents and binders have a parallel role system under `document-binder-roles/`.

---

## 4. Object / field metadata

```
GET /api/{version}/metadata/vobjects/{object_name}
GET /api/{version}/metadata/vobjects/{object_name}/fields/{object_field_name}
```

Object metadata exposes `role_overrides`, `dynamic_security`,
`secure_audit_trail`, `secure_sharing_settings`, `secure_attachments` — use these
to decide whether §3 matters for a given object.

Field metadata exposes `editable`, which is *session-user-relative* ("when true,
the field value can be defined by the currently authenticated user"). It is a
single boolean, not a CRUD breakdown, and it says nothing about provenance.

There is **no** "usable in permission sets" flag on field metadata.

---

## 5. Traps — endpoints that look relevant but are not

**Security Policies ≠ Security Profiles.**

```
GET /api/{version}/objects/securitypolicies
GET /api/{version}/objects/securitypolicies/{security_policy_name}
```

Despite the name, a Vault "Security Policy" governs **authentication and password
rules** — `authentication_type__v`, `min_password_length__v`,
`password_expiration__v`, etc. It has nothing to do with object or field access.
Do not conflate it with security profiles.

---

## 6. Permission sets — NOT retrievable via REST

This is the central limitation of this skill.

From `general.veevavault.dev/mdl/component-types/permissionset`:

> "Permission sets are a way to group permissions together. Security profiles
> then use the permission sets to grant or restrict users' access to certain
> features."
>
> "Note that the configuration of this component varies by Vault. Permissionset
> metadata is **not available** through the Retrieve Component Type Metadata
> endpoint in Vault API."

MDL operation support for `permissionset`:
Create/Recreate/Alter/Drop/Rename/Generate Recreate = **Yes**;
**Describe = No; Queryable = No.**

The related `rolepermissionset` component ("assign permissions to a specific user
without affecting security profiles") *is* Describable and Queryable, and carries
`application_role` plus a `permission_sets` reference limited to one entry.

### Consequence

No documented REST endpoint will tell you:
1. Which permission sets a user is assigned.
2. What grants a given permission set contains.
3. What permission sets a security profile links to.

The §1 endpoint returns the **outcome** with **no trail**.

---

## 7. Security model chain

```
User
 └─ security_profile__v  (exactly one; readable via §2)
      └─ references one or more Permission Sets   [NOT readable via REST]
           └─ each grants object / field / tab / admin CRUD  [NOT readable via REST]
 └─ Role Permission Sets (rolepermissionset)  — additive, role-scoped grants
    "without affecting security profiles"
 └─ Object Record Roles — per-record sharing (§3), only for objects with
    dynamic_security / secure_sharing_settings
```

**No precedence rule is documented.** veevavault.dev never states whether grants
are additive, whether "most restrictive wins," or whether permission sets are
capped by the application license. The only hint is the `rolepermissionset`
phrasing above, implying additive/supplementary behaviour. Conflict resolution
(profile denies edit, permission set grants it) is undocumented on the developer
site; that detail lives in Vault Help (`platform.veevavault.help`), not here.

Do not assert a precedence rule to users as fact.
