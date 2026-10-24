// RT-713: deliberate contract regressions applied in memory to a synthetic document, to prove
// each idempotency/replay rule can actually fail. Test-only: they never touch a real contract.
import { deref, indexOperations, jsonSchemaOf } from "./spec.mjs";

const idempotentOps = (docs) =>
  [...indexOperations(docs).values()].filter((e) => e.op["x-idempotency"] === "required");

const eachOp = (fn) => (docs) => idempotentOps(docs).forEach(fn);

function optionalKeyHeader({ op, doc }) {
  op.parameters = op.parameters.map((p) => {
    const r = deref(p, doc);
    return r.name === "Idempotency-Key" ? { ...r, required: false } : p;
  });
}

// A candidate that now demands a field an old client never sent: replay must reject the old body.
function stricterBody({ op, doc }) {
  const schema = jsonSchemaOf(deref(op.requestBody, doc).content, doc);
  schema.required = [...(schema.required ?? []), "newRequiredField"];
  schema.properties = { ...schema.properties, newRequiredField: { type: "string" } };
}

export const MUTATIONS = {
  none: () => {},
  drop_x_idempotency: eachOp(({ op }) => delete op["x-idempotency"]),
  optional_key_header: eachOp(optionalKeyHeader),
  drop_409: eachOp(({ op }) => delete op.responses["409"]),
  stricter_body: eachOp(stricterBody),
};

/** @returns a mutated deep copy of docs, or throws for an unknown mutation */
export function mutate(docs, name) {
  if (!Object.hasOwn(MUTATIONS, name)) throw new Error(`unknown mutation '${name}'`);
  const copy = structuredClone(docs);
  MUTATIONS[name](copy);
  return copy;
}
