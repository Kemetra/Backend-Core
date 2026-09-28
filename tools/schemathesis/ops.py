"""List the cookie-authenticated operations to test, one contract file per line.

Usage: ops.py <contracts dir> <owner|platform>

  owner     operations the seeded tenant owner can reach
  platform  operations restricted to platform admins (@PlatformAdminOnly).
            The contracts mark these with a 403 response described as
            "... not a platform admin"; they are run with a platform-admin
            session so their handlers are exercised, not just the 403.

Skipped: signOut and refreshSession (they would end the test session) and
operations marked `x-runtime-status: contract-only` (no route is shipped).

Output: `<file relative to the contracts dir> <operationId> [<operationId> ...]`.
Runs inside the pinned Schemathesis image (it ships PyYAML).
"""
import pathlib
import sys

import yaml

EXCLUDED = {"signOut", "refreshSession"}
METHODS = {"get", "post", "put", "patch", "delete"}


def is_platform_only(op):
    forbidden = (op.get("responses") or {}).get("403") or {}
    return "platform admin" in str(forbidden.get("description", "")).lower()


def cookie_ops(doc, group):
    default = doc.get("security")
    for item in (doc.get("paths") or {}).values():
        for method, op in item.items():
            if method not in METHODS:
                continue
            if op.get("operationId") in EXCLUDED:
                continue
            if op.get("x-runtime-status") == "contract-only":
                continue
            security = op.get("security", default) or []
            if not any("cookieAuth" in req for req in security):
                continue
            if is_platform_only(op) == (group == "platform"):
                yield op["operationId"]


root, group = pathlib.Path(sys.argv[1]), sys.argv[2]
if group not in ("owner", "platform"):
    sys.exit(f"unknown group: {group}")
for path in sorted(root.rglob("*.yaml")):
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    ids = list(cookie_ops(doc, group))
    if ids:
        print(path.relative_to(root).as_posix(), *ids)
