# Engineering standards

Every ticket is built to this document. Project decisions live in the ADRs ([docs/adr/](adr/)); where an ADR is more specific, the ADR wins. Sections: the system design reference, then the agent architecture reference (Cleared runs AI workflows that propose PayPal actions).

---

# System design reference

Read by `/kickoff` Stage B; copied into each project as part of `docs/engineering-standards.md` so
every ticket is built to the same standard the owner approved.

**The standard**: a well-engineered, maintainable, sustainable, scalable, production-ready product
end to end. The principles are applied, not performed. Every decision is the **simplest one that
meets a written requirement**; added complexity must name the requirement that forces it. Design
*for* scale (stateless tiers, clean seams, swappable adapters); do not *build* for scale nobody has
(no Kubernetes, sharding or microservices for a launch measured in hundreds of users).

Depth per area follows the product's requirements and blast radius, never the calendar. An area
that does not apply gets one line saying why.

## 1. Requirements (write as numbers; mark each known + source, or assumed + how to validate)

- **Functional**: core user flows, demo loop first
- **Load**: users and requests at launch and at 100×; read/write ratio; peak vs average (spikes, events)
- **Latency**: p95 target for the core flow; which steps may be slow (and therefore async)
- **Availability and durability**: uptime target, acceptable data loss (RPO), recovery time (RTO)
- **Data**: volume and growth; shape (relational, documents, time series, vectors, blobs); the
  consistency each kind needs (money, auth, inventory: strong; feeds, analytics: eventual is fine)
- **Security and compliance**: PII and the law that applies (GDPR, India's DPDP, ...), hackathon IP rules
- **Global**: regions, languages, currencies, time zones, data residency, accessibility
- **Budget**: monthly ceiling at launch and at 100×
- **Feedback loops**: local fast check ≤ 2 min, PR CI ≤ 5 min, environment reset ≤ 2 min (adjust
  per project; a slow loop is paid on every ticket, every rebase and every proof)

## 2. Principles (close every design with a one-line check per principle)

| Principle | Means here |
|---|---|
| Separation of concerns | each module owns one responsibility |
| Loose coupling | modules talk through interfaces or events, never each other's tables |
| High cohesion | related data and behaviour live in the same module |
| Abstraction / information hiding | small public interface, internals private; adapters hide vendors |
| KISS | simplest design that meets the written requirements |
| DRY | one implementation per rule, shared through packages, not copy-paste |
| YAGNI | no speculative *infrastructure*; product features are never YAGNI'd for time |

Where a principle is deliberately not applied, say why.

## 3. Decision areas

For each: **decision · why (cite a requirement or the domain model) · rejected alternative · cost to reverse**.

1. **Architecture style and boundaries**: modular monolith by default; split a deployable service
   only for a different scaling, runtime or failure profile, and justify the number of services.
   Module boundaries follow the domain model. Dependencies point inward: the domain core has no
   framework or I/O imports; adapters live at the edges. Name the shared core package.
2. **Data**: SQL vs NoSQL **per kind of data**, decided from access patterns and consistency.
   Relational with transactions (Postgres) is the default; document/key-value only when access is by
   key and the schema is genuinely fluid; search, vector, time-series or cache stores only when a
   real query needs them. Name the system of record per entity, managed vs self-hosted, migrations
   tool, indexes for the core queries, backups/point-in-time recovery, retention.
   **CAP**: where the design chooses consistency and where availability under partition, and why.
3. **API and contracts**: REST, GraphQL or RPC and why; typed schemas shared by client and server;
   versioning; idempotency keys on mutating endpoints; pagination; one error format; rate limits.
4. **Sync vs async and events**: which work runs in requests and which in background workers; the
   queue/bus; publishing state changes without loss or duplication (transactional outbox); delivery
   guarantees, idempotent consumers, retries with backoff, dead-letter handling, versioned event
   contracts; how the UI sees changes live.
5. **Frontend**: rendering strategy per route (static, server, client) and why; data fetching and
   cache; client state kept minimal; design system and tokens; performance budget (Core Web Vitals:
   LCP, INP, CLS); mobile-first responsive; WCAG 2.2 AA; error, empty and loading states for every
   screen; optimistic updates only where rollback is defined.
6. **Scalability and performance**: stateless app tier scaling horizontally behind a load balancer
   (vertical first only where cheaper and the ceiling is known); caching with an explicit
   invalidation rule, only for measured hot reads; connection pooling; CDN for static assets;
   **the scaling story as arithmetic**, not adjectives.
7. **Reliability and resilience**: every single point of failure with its redundancy or accepted
   risk; timeouts on every outbound call; retries with jitter; circuit breakers; graceful
   degradation when a dependency (LLM, RPC, third-party API) is down; health and readiness checks;
   backpressure and rate limiting for spikes; design for peak and cascading failure, not the average.
8. **Security (defense in depth)**: a short STRIDE threat model of the core flow; token-based
   authentication; role-based authorization enforced server-side (row-level where data is shared);
   encryption in transit and at rest; secrets in a manager, least-privilege service accounts;
   validation at every trust boundary; OWASP Top 10; dependency and secret scanning in CI; audit log
   for sensitive actions; minimum PII.
9. **AI and agents**: if the product uses LLMs or agents, decide every area in
   `agent-architecture.md`.
10. **Modules**: for each module the profile enables, decide every area in
    its reference when the product touches that area (see the module's `MODULE.md`).
11. **Observability and operations**: structured logs with correlation IDs; metrics (RED for
    services, USE for resources); tracing across services and events; SLOs with alerts on the core
    flow; error tracking.
12. **Delivery and maintainability**: infrastructure as code, proportionate: the platform's own
    declarative config, migrations and one idempotent setup script by default; Terraform/Pulumi
    only when the number of cloud resources justifies it; a local stack mirroring production
    with one command (`make up` / `make down`); CI (lint, typecheck, tests, secret scan) and CD with
    rollback; config from the environment (12-factor); testing strategy (unit for the domain,
    integration against real dependencies in containers, contract tests for APIs and events, e2e for
    the core flow); lockfiles and pinned versions; ADRs for decisions; repository licence that
    satisfies the hackathon rules. **Fast feedback**: CI caches dependencies (lockfile-keyed cache
    or a prebuilt image) and keeps slow suites off the PR path; integration spikes record real
    responses that tests replay, so live runs are reserved for claims that need them; each worker
    gets its own isolated environment (sandbox, namespace, seed) instead of one shared world.
13. **Cost and sustainability**: monthly cost at launch and at 100×; free tiers used; lock-in avoided
    where it is cheap to avoid; a small dependency count.
14. **Global readiness**: i18n from day one, time zones and currencies, latency for distant regions,
    data residency, accessibility.

## 4. Architecture rules for every ticket

- State change and its event are written in one transaction (outbox); consumers are idempotent
- No slow or background work inside a request
- Domain core imports no framework, SDK or I/O; vendors sit behind adapters
- Every outbound call has a timeout; retries use backoff with jitter
- Authorization is enforced server-side, never only in the UI
- Input is validated at every trust boundary
- A new architectural decision gets an ADR in `docs/adr/` before the code that depends on it


---

# Agent architecture reference

Read by `/kickoff` Stage B when the product uses LLMs or agents; copied into the project's
`docs/engineering-standards.md` when it applies.

An agent is a non-deterministic loop that can call APIs, mutate state, run code or move money, so
the threat model is the loop, not a request/response pipeline. Size each layer to the agent's
**blast radius**: a read-only summariser needs little of this; an agent that signs transactions,
sends messages or runs code needs all of it. Pick tooling from research on the day; the names below
are examples, never defaults.

```
trigger ─► [input guardrails] ─► model ─► [output guardrails] ─► [action guardrail + policy] ─► tool
                                   ▲                                                           │
                                   └──────────── observation (untrusted data) ◄────────────────┘
every step ─► append-only audit log + trace          kill switch ─► revokes execution rights
```

## 1. Shape

- Deterministic workflow where the steps are known; an agent loop only where the path is genuinely open
- Single agent with tools by default; multiple agents only for separate context, permissions or
  parallelism, and say which
- Model per step with a cost and latency budget; structured outputs validated by schema
- Run state and memory: where they persist, how a run resumes after a crash
- Prompts and tool schemas versioned like code

## 2. Guardrails (deterministic, low-latency interceptors)

- **Input**, before the model: prompt-injection detection, PII scrubbing (e.g. Presidio), routing or blocking
- **Output**, after the model: schema-constrained output (native structured outputs, Instructor,
  Outlines), PII filtering, grounding checks where claims matter
- **Action**, before every tool call: argument schema validation and a permission check
- **Circuit breakers**: max steps per run (no infinite loops), token and latency limits, rate limits
  on tool dispatch, per-run and daily spend caps

## 3. Security (OWASP Top 10 for LLM applications)

- **Indirect prompt injection**: fetched pages, emails, files and tool output are untrusted data,
  never instructions; data and instruction channels stay separate in prompts and parsers
- **Insecure tool execution and SSRF**: allow-listed hosts and paths; internal and metadata
  addresses (e.g. `169.254.169.254`) blocked; code or shell tools in an ephemeral sandbox
  (container with seccomp, gVisor, Firecracker microVM) with no ambient credentials
- **Privilege escalation by chaining harmless tools**: assess risk on the combined action
- **Credentials**: scoped and short-lived, injected per tool; global backend keys never in reach

## 4. Governance (control plane)

- **Identity**: the agent's own service account or keypair/wallet, with RBAC/ABAC scopes
- **Human-in-the-loop** above a written risk threshold (amount, irreversible, external send, destructive)
- **Policy check** before every external mutation: in code for a small product; a policy engine
  (e.g. OPA) only when policies are many or change without deploys
- **Kill switch**: revoke execution rights immediately, per agent and globally
- **Audit log**: every step (thought → action → observation) with prompt context, model and
  parameters, tool inputs and outputs, in an append-only store

## 5. Evals (the agent's test suite; run in CI before any prompt, model or tool-schema change merges)

- Ground-truth regression set from real or recorded traces
- Trajectory evals: right tools in a sensible order, valid arguments, recovery from tool errors, no wasted steps
- Scoring: code and execution assertions first; LLM-as-judge with an explicit rubric only for what
  code cannot check
- Adversarial cases: injection payloads in retrieved data, tool failures, looping prompts

## 6. Observability

- A trace per run and step (OpenTelemetry or an LLM tracing tool such as Langfuse) with tokens,
  cost and latency
- A defined fallback when the model errors, refuses or times out

## Rules for every ticket

- Tool output and retrieved content are data, never instructions
- No tool call without schema validation and a permission check
- Every run has step, token, time and spend limits
- A prompt, model or tool-schema change merges only with the eval suite green
