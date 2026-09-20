// Runtime statistics for the add-on's Ingress panel and its JSON API.
//
// Why this exists: until now the ONLY evidence the add-on was doing anything was the log,
// which you read when something already looks wrong. Everything below is counted at the
// points where the proxy already computes a before/after, so collecting it is close to free.
//
// An important honesty constraint runs through this file. Three of the four trims have a
// genuine, measurable before/after — the proxy holds HA's full answer and its own trimmed
// answer in the same function, so "saved" is a subtraction, not a model. The event stream
// does NOT: HA filters it server-side from the entity_ids we injected, so the untrimmed
// volume never exists anywhere and cannot be measured. It is therefore reported as
// throughput ("what this client is receiving"), never as a saving. Inventing a counterfactual
// there would make the headline number bigger and make the panel a liar.
//
// All byte counts are UNCOMPRESSED payload — what the browser must parse. With
// compress_websocket on, fewer bytes than this cross the wire.

const MAX_CATS = 64;          // guards the category map against an unbounded key space

export const startedAt = Date.now();

// category -> { count, before, after }. Categories: states, registry:<kind>, services,
// resources. "before" is HA's answer, "after" is what the browser got.
const trims = new Map();
// Event stream, throughput only — see the note above about why this is not a saving.
const events = { count: 0, bytes: 0 };
// Registry answers served from the local cache without asking HA at all.
// Live connections, keyed by a monotonic id.
const conns = new Map();
let nextConnId = 1;
// Lifetime connection count, so the panel can show churn rather than just what's open now.
let connTotal = 0;

export function recordTrim(category, before, after) {
  let t = trims.get(category);
  if (!t) {
    if (trims.size >= MAX_CATS) return;
    t = { count: 0, before: 0, after: 0 };
    trims.set(category, t);
  }
  t.count += 1; t.before += before; t.after += after;
}

export function recordEvent(bytes) { events.count += 1; events.bytes += bytes; }


export function connOpen({ ip, dash, via, allowSize }) {
  const id = nextConnId++;
  connTotal += 1;
  conns.set(id, {
    id, ip: ip || null, dash: dash || null, via: via || null, allowSize: allowSize || 0,
    since: Date.now(), fromHA: 0, toBrowser: 0, eventBytes: 0, msgs: 0,
  });
  return id;
}

export function connClose(id) { conns.delete(id); }

export function connTraffic(id, inBytes, outBytes, isEvent) {
  const c = conns.get(id);
  if (!c) return;
  c.msgs += 1;
  c.fromHA += inBytes;
  c.toBrowser += outBytes;
  if (isEvent) c.eventBytes += outBytes;
}

const pct = (before, after) => (before > 0 ? Math.round(((before - after) / before) * 1000) / 10 : 0);

// `extra` carries the things only the proxy knows: version, options, allowlist sizes,
// per-dashboard resource figures. Kept as a parameter rather than an import so this module
// stays a pure counter and the tests can drive it without booting the proxy.
export function snapshot(extra = {}) {
  const now = Date.now();
  const byCategory = {};
  let before = 0, after = 0;
  for (const [k, t] of trims) {
    byCategory[k] = { count: t.count, before: t.before, after: t.after, saved: t.before - t.after, savedPct: pct(t.before, t.after) };
    before += t.before; after += t.after;
  }
  const clients = [...conns.values()].map((c) => {
    // A per-minute rate taken from a connection that is four seconds old is not a
    // measurement, it is that connection's opening burst multiplied by fifteen. Report null
    // until a full minute exists to divide by, and let the panel render that as "—".
    const ageMs = now - c.since;
    const rate = ageMs >= 60000 ? Math.round(c.eventBytes / (ageMs / 60000)) : null;
    return {
      id: c.id, ip: c.ip, dashboard: c.dash, attributedVia: c.via, allowSize: c.allowSize,
      connectedSec: Math.round((now - c.since) / 1000), messages: c.msgs,
      fromHA: c.fromHA, toBrowser: c.toBrowser,
      eventBytes: c.eventBytes,
      eventBytesPerMin: rate,
    };
  }).sort((a, b) => a.id - b.id);

  return {
    version: extra.version ?? null,
    uptimeSec: Math.round((now - startedAt) / 1000),
    startedAt: new Date(startedAt).toISOString(),
    generatedAt: new Date(now).toISOString(),
    options: extra.options ?? {},
    allowlist: extra.allowlist ?? {},
    resources: extra.resources ?? {},
    // Request/response payloads, where a real before/after exists.
    savings: { before, after, saved: before - after, savedPct: pct(before, after), byCategory },
    // Throughput only. Deliberately NOT folded into `savings` — see the file header.
    eventStream: {
      count: events.count,
      bytes: events.bytes,
      bytesPerMin: Math.round(events.bytes / Math.max((now - startedAt) / 60000, 1 / 60)),
    },
    clients: { open: conns.size, total: connTotal, list: clients },
  };
}

// Test seam: the counters are module-level, so a test that wants a clean slate says so.
export function reset() {
  trims.clear();
  events.count = 0; events.bytes = 0;
  conns.clear();
  nextConnId = 1; connTotal = 0;
}

// Who may read the stats port. Ingress requests reach the add-on from Supervisor on the hassio
// network (172.30.32.0/23) and local tools from loopback; with host_network the port is bound
// on the host itself, so anything else is the LAN, which sees client addresses, entity counts
// and uptime unauthenticated. Judged by source address, never by headers: X-Ingress-Path is
// whatever the caller chose to send. `stats_lan: true` opens it for a `rest` sensor.
export function statsPeerAllowed(ip, lan = false) {
  if (lan) return true;
  const a = String(ip || '').replace(/^::ffff:/, '');
  return a === '::1' || /^127\./.test(a) || /^172\.30\.3[23]\./.test(a);
}
