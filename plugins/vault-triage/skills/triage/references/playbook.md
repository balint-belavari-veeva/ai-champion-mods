# Investigation playbook: Vault CRM (read-only)

Targeting and commands: `environments.md`. First confirm which Vault you were told to
look at and validate `vault status` against it; not logged in → print the login code.
Only then query. Names: standard `__v`, system `__sys`, custom `__c`. Discover real
field and object names with `vault api /metadata/vobjects/<object>`; never guess. For
anything beyond a simple query use the `vault:query` skill (relationship syntax, IS
NULL, paging).

VQL limits to remember: **no COUNT or other aggregates**, one level of subquery
nesting, relationship joins are slow (prefer two queries), manual `PAGEOFFSET` over
10,000 records errors, duplicate queries within 5 min return a harmless warning. Select
only needed fields.

## Docs (do this before calling anything a bug or "works as designed")
Vault docs MCP:
- Behaviour/admin: `search_documentation`, `source: vault_help_documentation`,
  `app_family: vault_crm`, `release: limited`.
- API/VQL/MDL/SDK: `vault_developer_documentation` or `vault_api_reference`, same
  `app_family` and `release`. Fetch the `markdown_url` for the full page.
- Behaviour changed recently: `search_release_notes`.
Cite the page. CRM docs are limited-release only: say when the user's release may
differ. Veeva CRM (Salesforce) behaviour is **not** a safe proxy; data model and names
changed (for example Align `__aln` → `__v`, Align Loader deprecated in favour of Vault
Loader).

## Sequence
1. **Pin the record.** By ID or name:
   `vault query "SELECT id, name__v, status__v FROM <object> WHERE name__v = '<name>'" --format json`.
   Then related records. Objects seen often: `account__v`, `address__v`, `call2__v`,
   `user__sys`, `user_territory__v`, `account_territory__v`, `territory__v`,
   `my_setup_products__v`, `restricted_products__v`, `content_group_user__v`,
   `data_change_request__v`, `time_off_territory__v`, `medx__v`. Confirm each exists
   with the metadata call.
2. **Data integrity.** Wrong state or lifecycle state, inactive or missing lookup
   targets, duplicates, hidden characters, missing required fields (for example
   `country__v` is required on every user), stale integration data, records locked by a
   flag such as `lock__v`.
3. **Compare a working user to a failing user.** `user__sys`: `security_profile__sys`,
   `status__v`, country, roles (`user_role__sys`), group membership (`group__sys`).
   List exactly what differs.
4. **Access.**
   - Object and field permissions, and which profile/permission set grants them: the
     `veeva-vault-permissions` skill if installed, otherwise VQL on the user's security
     profile and permission sets.
   - Record access: sharing rules, territory-based visibility, dynamic access control
     (custom sharing rules enabled per object), and parent-child security (account child
     objects inherit the parent account's access). Read the component config
     (`/configuration/…` or MDL) rather than inferring.
   - Identify which profile or permission set grants what is missing; fixing it is an
     admin's job, not yours.
5. **Visibility.** Territory assignment (`user_territory__v`, `account_territory__v`);
   Align-managed territories are sourced from Align. Product visibility:
   `my_setup_products__v`, `restricted_products__v` (a restricted product hides content
   and sampling for the HCP). Content group membership for CLM content.
6. **Config.** Layouts and layout rules, lifecycle and states, picklists, settings:
   `/configuration/<Type>` for JSON, MDL via the `--api-version none … -o` read in
   `environments.md`. For broad comparisons use `vault-administrator:config`.
7. **Audit trail.** Who changed a record, permission set or setting and when. Use the
   audit trail API for the object (confirm the endpoint in the API reference) and ask
   the user for the Admin audit log if no API covers it.
8. **Drift between Vaults.** Only when the user asks for a comparison:
   `vault switch --dns <dns>` (after the user's yes, see `environments.md`), re-run
   `vault status`, repeat the same check, switch back. Release can differ between them.
9. **Client-side and user-level.** Vault CRM issues are often device or integration
   issues: Outlook calendar connection and sync, iPad/iPhone app build (App Store vs
   other builds), CRM Desktop / Windows, Engage Connect or Meeting licences. Ask the
   user for app version, platform, and error text or logs. These often come down to a
   user-level connection or setting, but that is a hypothesis until the data shows it.
10. **Precedent.** Plain Zendesk keyword strings, for example
    `"Outlook" "pull activity" Vault CRM`.

## Impact queries (labeled)
`vault api -X POST -H "Content-Type: application/x-www-form-urlencoded" /query -d "q=SELECT id FROM user__sys WHERE status__v = 'active__v' AND security_profile__sys = '<profileId>' PAGESIZE 0"`
and read `responseDetails.total`. Report as "N active users on <profile> could hit
this". If the population can't be defined, say so rather than invent a number.

## Rules of thumb
- Prove the cause with a query result, not an inference from a name.
- A past-ticket match is a hypothesis; verify it on this record.
- If the evidence supports two causes, say so and name the check that separates them.
- Don't assume business process. Ask the user.
