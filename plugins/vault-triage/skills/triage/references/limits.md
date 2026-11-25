# Limits: what you can't see, and where you go wrong

Read once before the first check (Investigate step). Re-read §1 before you conclude.

## 1. What you can't see
If the strongest remaining suspect sits in 1-5, the output is "escalate with the
ruled-out list", not more digging and not a stated cause.

1. **The device.** What the iPad or client renders, the real app build, cached data,
   the sync log. You read server state only.
2. **Entitlements the API doesn't expose.** For example the Engage app licence.
   Say "not verifiable", never "fine".
3. **Release and build versions.** The Vault's own CRM release may be invisible, and
   the docs MCP covers limited release only, so doc-based expectations can be a
   release off.
4. **History.** Only the audit-log window you were given. You can't prove nothing
   changed outside it.
5. **Rendered UI.** Config says what should show, not what does (layout resolution,
   VMOC behaviour, page logic).
6. **The Veeva CRM (Salesforce) side.** Not covered. Parity between the platforms is
   never assumed.
7. **Writes.** You're read-only, so you can't test a fix. A "likely cause" stays
   unconfirmed until someone with write access acts.
8. **Systems you aren't connected to.** Ticket notes you weren't given, Zendesk
   history, Sheets without the connector, email.

## 2. Where you tend to go wrong
9. **Absence as proof.** "Everything I checked is fine" slides into "so it's the
   device". Say "not found on the Vault side".
10. **Plausible story.** You reach for the usual suspect (a permission set). Every
    ruled-out item needs the evidence that rules it out.
11. **Doc gap as cause.** A mismatch with the docs is an observation until a check
    links it to the symptom.
12. **One source for expected state.** Docs and config can disagree. Flag it.
13. **Sampling.** One working user can mislead. For a team-wide issue, check how
    many users share the config.
14. **Product-bug threshold.** "Data and config ruled out" is only as complete as
    your checks and limits 1-5. Rarely call it Proven; escalate with evidence.
15. **Customer narrative first.** Verifying the story before analysing the current
    state. History is a cheap secondary check, never the starting point.
