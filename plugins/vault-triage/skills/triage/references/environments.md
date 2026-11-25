# Vault CRM: targeting and CLI

## Targeting: get told, then validate, before reading anything
The `vault` CLI has **no `--dns` flag** on `query`/`api` (only `login` and `switch`
take it). Every command hits the *active* Vault of the current user, and other sessions
or skills can switch it. So, every time:
1. **You were told which Vault** (name or DNS) the issue is in. If not, ask. Never
   assume Production.
2. `vault status` → compare the DNS to the Vault named. Same → go on.
3. Different → say which is active and which is needed, and that switching changes the
   active Vault for the user's other sessions too. **Wait for a yes**, then
   `vault switch --dns <DNS of the named Vault>`, then `vault status` again. Not
   reachable or session expired → print the login code (below), wait.
4. Say it in one line: `Vault: <name> (<DNS>), Production|Sandbox`.
5. Repeat step 2 before every new batch of Vault commands.

Classify production vs sandbox from the Vault, not from the name: `vault api
/objects/domain` → `domain_type__v` (`Production` / `Sandbox`) and each Vault's `id`,
`vault_name__v`, `vault_family__v` (`vaultcrm__v` = Vault CRM). That Vault `id` is also
the **Environment ID for Zendesk**. Only investigate Vaults whose family is Vault CRM.

## Not logged in: print this for the user
Fill in the DNS of the Vault the issue is about, show it as a code block, and tell the
user to paste it into a terminal (macOS/Linux) or PowerShell (Windows). It opens a
browser login. In Claude Code they can also type it with a `!` prefix.

```
vault login --dns <DNS>
vault status
```

The second line confirms the session and the active Vault. If the user is logged in to
a different Vault, `vault switch --dns <DNS>` selects the right one. Never ask for
passwords, tokens or session IDs in chat.

## Release awareness
Vault CRM Help and developer docs on the docs MCP are **limited-release only** (every
3-5 weeks); the user's Vault may run a different release, and sandboxes can be on a
different release than Production. When "worked before" or "started after a release",
check `search_release_notes` and ask the user which release the Vault runs. Say in the
output when a documented behaviour may not yet be live in their Vault.

## Useful read commands
| Need | Command |
|---|---|
| Active Vault | `vault status` |
| VQL | `vault query "<VQL>" --format json [--all]` (1000 rows/page) |
| Count | `vault api -X POST -H "Content-Type: application/x-www-form-urlencoded" /query -d "q=SELECT id FROM <obj> WHERE … PAGESIZE 0"` → `responseDetails.total` (VQL has no COUNT) |
| Field names | `vault api /metadata/vobjects/<object>` |
| Config list | `vault api /configuration/<Componenttype>` (JSON) |
| Component as MDL | `vault api --api-version none "/api/mdl/components/<Type>.<name>" -o <file>` (text, needs `-o`; never `vault mdl`, it executes statements) |
| Current user | `vault api /objects/users/me` |
| Bulk config | `vault-administrator:config` skill pulls config to a local workspace |
| Permissions | `veeva-vault-permissions` skill if installed; otherwise VQL on the user's security profile and permission sets |
| VQL help | `vault:query` skill for relationship syntax, IS NULL rules, paging |

Blocked by the guard: any non-GET API call except VQL `/query`, `vault mdl`,
`vault config push|package`. Triage is read-only so nothing is written by accident
while investigating.
