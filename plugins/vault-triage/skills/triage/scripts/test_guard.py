#!/usr/bin/env python3
"""Self-test for guard.py. Run: python3 -I scripts/test_guard.py"""
import json
import os
import subprocess
import sys
import tempfile

GUARD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "guard.py")

ALLOW = [
    "ls | wc -l",
    "python3 -c 'print(1)'",
    "vault status",
    "vault list",
    "vault switch --dns example-crm.veevavault.com",
    "vault query \"SELECT id FROM user__sys\" --format json",
    "vault --api-version v24.2 query \"SELECT id FROM user__sys\"",
    "vault api /objects/domain",
    "vault api /metadata/vobjects/call2__v",
    "vault api -X POST -H \"Content-Type: application/x-www-form-urlencoded\" /query -d \"q=SELECT id FROM user__sys PAGESIZE 0\"",
    "vault api --api-version none \"/api/mdl/components/Objectlifecycle.x__c\" -o /tmp/x.mdl",
    "vault config pull",
    "vault status && vault query \"SELECT id FROM account__v\" --format json",
    "bash -c 'vault status'",
]
BLOCK = [
    "vault mdl \"ALTER Picklist x__c ADD ...\"",
    "bash -c 'vault mdl \"DROP Object x__c\"'",
    "sh -c \"echo hi; vault mdl x\"",
    "eval 'vault mdl x'",
    "echo 1 | xargs vault mdl",
    "FOO=1 vault mdl x",
    "sudo vault mdl x",
    "echo $(vault mdl x)",
    "vault api -X POST /vobjects/call2__v -d \"a=b\"",
    "vault api -X PUT /vobjects/call2__v/1 -d \"a=b\"",
    "vault api -X DELETE /vobjects/call2__v/1",
    "vault api /vobjects/call2__v -d @rows.csv",
    "vault api -F file=@x.csv /services/file_staging/items",
    "vault config push",
    "vault config package deploy",
    "vault uninstall",
    "curl -X PUT https://example-crm.veevavault.com/api/v24.1/vobjects/x__c",
    "curl -X DELETE https://example-crm.veevavault.com/api/v24.1/vobjects/x__c/1",
    "python3 -c 'import subprocess; subprocess.run([\"vault\",\"mdl\",\"x\"])'",
]


def run(cmd):
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}})
    return subprocess.run([sys.executable, "-I", GUARD], input=payload, text=True,
                          capture_output=True).returncode


def main():
    bad = []
    for c in ALLOW:
        if run(c) != 0:
            bad.append(("should ALLOW", c))
    for c in BLOCK:
        if run(c) != 2:
            bad.append(("should BLOCK", c))
    with tempfile.TemporaryDirectory() as d:
        script = os.path.join(d, "x.py")
        with open(script, "w") as f:
            f.write("import subprocess\nsubprocess.run(['vault','mdl','x'])\n")
        if run(f"python3 {script}") != 2:
            bad.append(("should BLOCK", "python3 <script mentioning vault>"))
        fake = os.path.join(d, "vault_perms.py")
        with open(fake, "w") as f:
            f.write("import subprocess\nsubprocess.run(['vault','mdl','x'])\n")
        if run(f"python3 {fake}") != 2:
            bad.append(("should BLOCK", "lookalike vault_perms.py"))
    # The bundled permissions script is allowed by path (sibling plugin in this repo).
    perms = os.path.normpath(os.path.join(os.path.dirname(GUARD), "..", "..", "..", "..",
                                          "veeva-vault-permissions", "skills", "veeva-vault-permissions",
                                          "scripts", "vault_perms.py"))
    extra = 2
    if os.path.isfile(perms):
        extra += 1
        if run(f"python3 {perms} check --user me --object product__v") != 0:
            bad.append(("should ALLOW", "bundled vault_perms.py"))
    for kind, c in bad:
        print(f"FAIL {kind}: {c}")
    print(f"{len(ALLOW) + len(BLOCK) + extra - len(bad)} passed, {len(bad)} failed")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
