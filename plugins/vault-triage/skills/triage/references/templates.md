# Output templates

Read by people, so simple beats complete. Placeholders in `<angle brackets>`. Never copy
IDs, names or profile names from an example into a real output.

## Findings write-up (chat)

```
Issue: <who · where · what they see · what they should see · since when>
Vault: <name> (<DNS>), <Production|Sandbox>

Root cause (<Proven|Likely|Not found>): <one or two plain sentences, class: Data | Config | Working as designed | Product bug>

Evidence:
- <one line per check, then the exact VQL / call used>

Ruled out: <item (evidence)>, <item (evidence)>
Not ruled out: <item, why>

Impact: <N users who could hit this> · <Blocked | Slowed down> · Workaround: <text | none found>
Docs: <page cited>

Next: <what would change the confidence, or who to ask and what the answer would change>
```

## Zendesk product-support ticket

Escalation to Veeva product teams (internal, never customer-facing). Output each field
on its own line so it can be copied into the portal form.

| Field | Value |
|---|---|
| Title | specific to **this** issue, never reused from another ticket |
| Type | `Problem` (something broken) or `Question` (how should it behave) |
| Priority | `Low` unless the user says otherwise |
| Inbound Request Type | `Portal` |
| Business Line | `Commercial Cloud` |
| Application Family | `CRM Suite` |
| Application | `Vault CRM` |
| Application Area | e.g. My Schedule, CLM, Events Management, Approved Email |
| Feature | e.g. `Other My Schedule`, `Other CLM`, `Time off Territory` |
| Environment ID(s) | The Vault ID from `vault api /objects/domain`. Label prod / sbx when several |

Application Area and Feature values depend on the portal list: offer your best match and
tell the user to pick from the portal.

Internal Note:
```
Hi Team,

<User ID (name) or record ID> <concrete symptom>. <Where: production, sandbox, both?>

<Vault name> (<Vault ID>):
Example user: <user ID>
<Object>: <record ID>

<One-line label for each check, then the exact VQL used, e.g. "User's My Setup Products">
<VQL>

<What was already tried and did not help.>

<One-sentence ask: "Could you please check why this could be happening?">

Kind regards,
<name>
```

Put `[screenshot: …]` where the user should paste one. Keep the queries actually run;
they save Support a round trip. Zendesk notes may use line breaks and code formatting.
The name comes from `git config user.name`; never hardcode one.
