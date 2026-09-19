# Synchronization — Backend-Core at the Core

> Backend-Core is the **single contract boundary** of Retail Tower OS. Every edge syncs through
> it; only the connector ever reaches ERPNext.

<p align="center">
  <img src="../assets/architecture/retail-tower-sync-flow.svg" alt="Animated Retail Tower OS synchronization diagram, Backend-Core at the core" width="100%"/>
</p>

```text
POS-Pulse ─┐
           ├─▶  Backend-Core  ─▶  ERPNext-Connector  ─▶  ERPNext / Frappe
Console  ──┘        ▲ the only contract boundary
```

## Two directions

| Direction | What moves | Path |
|---|---|---|
| 🔵 **Read-DOWN** | Resolved sellable catalog, product master, prices | DP2 → POS / Console |
| 🟠 **Capture-UP** | Sales & inventory, posting feed + outcome ack | POS / Console → DP2 → Connector → ERPNext |

```mermaid
flowchart LR
    classDef edge fill:#1e3a8a,stroke:#60a5fa,color:#fff;
    classDef hub  fill:#7c3aed,stroke:#c4b5fd,stroke-width:3px,color:#fff;
    classDef conn fill:#b45309,stroke:#fbbf24,color:#fff;
    classDef erp  fill:#0f766e,stroke:#5eead4,color:#fff;

    POS["🖥️ POS-Pulse"]:::edge
    CON["📊 Console"]:::edge
    DP2["🛡️ Backend-Core<br/><small>contract boundary · RLS · outbox</small>"]:::hub
    CONN["🔌 ERPNext Connector"]:::conn
    ERP["🏛️ ERPNext / Frappe"]:::erp

    POS -- "capture-UP" --> DP2
    CON -- "operations" --> DP2
    DP2 -- "read-DOWN" --> POS
    DP2 -- "read-DOWN" --> CON
    DP2 <-- "posting feed / ack" --> CONN
    CONN <-- "DocType mapping" --> ERP
```

## A sale's round trip

```mermaid
sequenceDiagram
    autonumber
    participant POS as POS-Pulse
    participant DP2 as Backend-Core
    participant CN as Connector
    participant ERP as ERPNext
    ERP->>CN: product master / prices
    CN->>DP2: normalized catalog contract
    DP2-->>POS: resolved sellable snapshot + deltas
    POS->>DP2: finalized sale (idempotent, outbox)
    DP2->>CN: posting feed (pull, cursor)
    CN->>ERP: create posting
    ERP-->>CN: outcome
    CN-->>DP2: ack outcome (Idempotency-Key)
```

## What the boundary guarantees

| Concern | Guarantee |
|---|---|
| Tenant / store isolation | Postgres RLS — no cross-tenant leakage at the data layer |
| Contract of record | `packages/contracts/openapi/**` — edges depend on contracts, never on each other |
| ERPNext coupling | Isolated to the connector — edges stay ERPNext-agnostic |
| Money | Integer minor units / value objects — never floats |

Program-wide view: the
[Orchestrator](https://github.com/Kemetra/Orchestrator)
control plane.

> Architecture is stable; this document does not assert feature/merge status. See `specs/**`,
> `docs/agent-os/`, and `CLAUDE.md` for the authoritative implementation state.
