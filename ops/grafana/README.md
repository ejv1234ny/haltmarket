# Grafana dashboards

Import these dashboards into Grafana Cloud (or self-hosted Grafana) by
**Dashboards → New → Import → Upload JSON file**. They expect a Prometheus
datasource named `prometheus` scraping the haltmarket Railway services.

## Scrape config (add to Grafana Cloud Prometheus)

```yaml
scrape_configs:
  - job_name: haltmarket-monitor
    metrics_path: /metrics
    static_configs:
      - targets: ['haltmarket-monitor.up.railway.app:443']
        labels:
          service: monitor
    scheme: https

  - job_name: haltmarket-resolver
    metrics_path: /metrics
    static_configs:
      - targets: ['haltmarket-resolver.up.railway.app:443']
        labels:
          service: resolver
    scheme: https

  - job_name: haltmarket-deposit-watcher
    metrics_path: /metrics
    static_configs:
      - targets: ['haltmarket-deposit-watcher.up.railway.app:443']
        labels:
          service: deposit-watcher
    scheme: https
```

## Dashboards

| File | Covers | Required alerts |
|---|---|---|
| `monitor.json` | RSS poll lag, halts/min, classify errors, leader status | heartbeat gauge=0 for 60s |
| `resolver.json` | resolves/s, refunds/s, settlement latency, **invariant failures**, rehalt extensions | `haltmarket_resolver_invariant_failures_total > 0` |
| `deposit-watcher.json` | webhooks/s, deposits credited, RPC latency, rejected count | `up == 0` for 60s |

## Critical alerts

The resolver's `haltmarket_resolver_invariant_failures_total` counter is
the single most important alert — any non-zero value means the ledger has
drifted. When it fires, **freeze `place-bet` and follow
`docs/runbook-drift.md`**.

Grafana alert rule:

```yaml
- alert: LedgerInvariantFailure
  expr: increase(haltmarket_resolver_invariant_failures_total[5m]) > 0
  for: 0m
  labels:
    severity: critical
  annotations:
    summary: "Ledger SUM != 0 after resolve"
    runbook: "https://github.com/ejv1234ny/haltmarket/blob/main/docs/runbook-drift.md"
```
