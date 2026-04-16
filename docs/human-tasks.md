# Human-required tasks

Items `AGENTS.md` §9 defers to the operator. Each code-level `TODO(human):` marker should link back here.

| # | Item | Referenced in |
|---|------|---------------|
| 1 | Offshore legal entity formation | — |
| 2 | Regulatory classification (CFTC vs offshore vs sweepstakes) | — |
| 3 | ToS + Privacy Policy (lawyer-drafted) | — |
| 4 | KYC vendor selection | — |
| 5 | Payment processor integration (swap `StubProvider`) | Phase 8 `TODO(human)` markers |
| 6 | Banking / treasury / custody / multi-sig | — |
| 7 | Polygon.io paid-tier entitlement | `POLYGON_API_KEY` in `.env.example` |
| 8 | Nasdaq data licensing (if moving off RSS) | — |
| 9 | Domain / DNS / DKIM-SPF-DMARC | — |
| 10 | Geo-blocking policy | `geo_country` / `kyc_status` wiring |
| 11 | Responsible-gambling tooling (GamStop, self-exclusion) | — |
| 12 | Insurance (cyber, tech E&O, crime) | — |
| 13 | Smart-contract audit (if on-chain) | — |
| 14 | VAPID key generation | `VAPID_*` in `.env.example`, Phase 6 |
| 15 | First admin user provisioning | Phase 9 |
| 16 | Tax handling (1099s if US accepted) | — |
| 17 | Marketing site copy | — |
| 18 | Incident comms templates | — |
| 19 | Bug-bounty program | — |
| 20 | Production deploy sign-off | Phase 10 launch checklist |

`needs-human` GitHub issues opened during the build (per `AGENTS.md` §7) extend this list.
