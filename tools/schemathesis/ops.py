"""List the cookie-authenticated operations to test, one contract file per line.

Output: `<file relative to the contracts dir> <operationId> [<operationId> ...]`.
Runs inside the pinned Schemathesis image (it ships PyYAML).
"""
import pathlib
import sys

import yaml

# These end or rotate the test session; generated calls would log the job out.
EXCLUDED = {"signOut", "refreshSession"}
METHODS = {"get", "post", "put", "patch", "delete"}


def cookie_ops(doc):
    default = doc.get("security")
    for item in (doc.get("paths") or {}).values():
        for method, op in item.items():
            if method not in METHODS:
                continue
            security = op.get("security", default) or []
            if any("cookieAuth" in req for req in security):
                yield op["operationId"]


root = pathlib.Path(sys.argv[1])
for path in sorted(root.rglob("*.yaml")):
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    ids = [i for i in cookie_ops(doc) if i not in EXCLUDED]
    if ids:
        print(path.relative_to(root).as_posix(), *ids)
