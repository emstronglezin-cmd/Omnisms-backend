'use strict';
/**
 * OmniSMS — Métriques applicatives (exposition texte type Prometheus).
 *
 * Sans dépendance externe : registre de compteurs/jauges/histogrammes
 * minimaliste. Scrapé sur GET /metrics (voir server.js). Aucune donnée
 * personnelle ni secret dans les libellés.
 *
 * Usage :
 *   const { metrics } = require('./metrics');
 *   metrics.inc('http_requests_total', { route: '/health', status: 200 });
 *   metrics.setGauge('socket_connected', io.engine.clientsCount);
 *   metrics.observe('sms_send_duration_ms', 412);
 */

const MAX_LABEL_VALUES = 50; // garde-fou cardinalité

function serializeLabels(base, labels) {
  if (!labels) return base;
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/"/g, '')}"`);
  return parts.length ? `${base}{${parts.join(',')}}` : base;
}

const counters = new Map();   // clé sérialisée → valeur
const gauges = new Map();     // nom → valeur
const histograms = new Map(); // nom → { buckets, counts, sum, count }
const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

const metrics = {
  /** Incrémente un compteur (labels optionnels, valeur optionnelle). */
  inc(name, labels, value = 1) {
    const key = serializeLabels(name, labels);
    const cur = counters.get(key) || 0;
    if (!counters.has(key) && counters.size >= 5000) return; // anti-fuite mémoire
    counters.set(key, cur + Number(value) || 0);
  },

  /** Positionne une jauge (valeur absolue). */
  setGauge(name, value) {
    gauges.set(name, Number(value) || 0);
  },

  /** Observe une durée (ms) dans un histogramme cumulatif. */
  observe(name, ms, buckets = DEFAULT_BUCKETS) {
    if (!histograms.has(name)) {
      histograms.set(name, { buckets, counts: new Array(buckets.length).fill(0), sum: 0, count: 0 });
    }
    const h = histograms.get(name);
    const v = Number(ms) || 0;
    for (let i = 0; i < h.buckets.length; i++) {
      if (v <= h.buckets[i]) h.counts[i]++;
    }
    h.sum += v;
    h.count++;
  },

  /** Rendu texte type Prometheus (réponses 200 + # TYPE). */
  render() {
    const lines = [];
    const counterNames = new Set();
    for (const key of counters.keys()) counterNames.add(key.split('{')[0]);
    for (const name of counterNames) {
      lines.push(`# TYPE ${name} counter`);
      for (const [key, val] of counters.entries()) {
        if (key.split('{')[0] === name) lines.push(`${key} ${val}`);
      }
    }
    lines.push('# TYPE omnisms_gauge gauge');
    for (const [name, val] of gauges.entries()) lines.push(`omnisms_gauge{name="${name}"} ${val}`);
    for (const [name, h] of histograms.entries()) {
      lines.push(`# TYPE ${name} histogram`);
      let last = 0;
      h.buckets.forEach((b, i) => {
        lines.push(`${name}_bucket{le="${b}"} ${h.counts[i] - last}`);
        lines.push(`${name}_bucket{le="+Inf"} 0`); // placeholder remplacé ci-dessous
        lines.pop();
        if (i === h.buckets.length - 1) lines.push(`${name}_bucket{le="+Inf"} ${h.count}`);
        last = 0; // cumulatif : les counts sont déjà cumulés par construction
      });
      lines.push(`${name}_sum ${h.sum}`);
      lines.push(`${name}_count ${h.count}`);
    }
    return lines.join('\n') + '\n';
  },

  /** Snapshot JSON (pour /readyz ou debug). */
  snapshot() {
    return { counters: Object.fromEntries(counters), gauges: Object.fromEntries(gauges) };
  },

  MAX_LABEL_VALUES,
};

/* ── Helpers de haut niveau ─────────────────────────────────── */
const metricsService = {
  metrics,
  /** Compte une requête HTTP (branchée dans le requestLogger). */
  httpRequest(method, path, status, durationMs) {
    const route = String(path || '').split('?')[0].slice(0, 60);
    metrics.inc('omnisms_http_requests_total', { method, route, status: String(status) });
    metrics.observe('omnisms_http_request_duration_ms', durationMs);
    if (status >= 500) metrics.inc('omnisms_http_5xx_total', { route });
  },
  /** Statut d'un envoi SMS (pour taux de livraison). */
  smsSend(provider, ok, durationMs) {
    metrics.inc('omnisms_sms_send_total', { provider, result: ok ? 'ok' : 'error' });
    if (durationMs != null) metrics.observe('omnisms_sms_send_duration_ms', durationMs);
  },
  /** Statuts de messages (delivered/failed via DLR). */
  smsDelivery(status) {
    metrics.inc('omnisms_sms_delivery_total', { status: String(status || 'unknown').slice(0, 20) });
  },
  /** Profondeur d'une file (jauge périodique). */
  queueDepth(queue, depth) { metrics.setGauge(`queue_depth_${String(queue).slice(0, 24)}`, depth); },
  /** Débit par appareil passerelle. */
  deviceSend(deviceId, ok) { metrics.inc('omnisms_device_send_total', { device: String(deviceId).slice(0, 32), result: ok ? 'ok' : 'error' }); },
  /** Appareil hors ligne / circuit breaker. */
  deviceAlert(deviceId, alert) { metrics.inc('omnisms_device_alerts_total', { device: String(deviceId).slice(0, 32), alert: String(alert).slice(0, 24) }); },
  /** Sockets connectés. */
  sockets(count) { metrics.setGauge('socket_connected', count); },
  /** Opérations Firestore. */
  firestoreOp(op, collection) { metrics.inc('omnisms_firestore_ops_total', { op, collection: String(collection).slice(0, 24) }); },
  /** Paiements OM. */
  payment(status) { metrics.inc('omnisms_om_payment_total', { status: String(status).slice(0, 16) }); },
};

module.exports = { metrics, metricsService };
