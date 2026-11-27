const API_BASE = "https://apis.deutschebahn.com/db-api-marketplace/apis/ris-disruptions-transporteure/v1";
const SOURCE_URL = "https://www.bahn.de/service/fahrplaene/";
const MANUAL_SNAPSHOT = require("../data/db-disruptions.json");
const STATES = [
  "BADEN_WUERTTEMBERG", "BAYERN", "BERLIN", "BRANDENBURG", "BREMEN", "HAMBURG", "HESSEN",
  "MECKLENBURG_VORPOMMERN", "NIEDERSACHSEN", "NORDRHEIN_WESTFALEN", "RHEINLAND_PFALZ",
  "SAARLAND", "SACHSEN", "SACHSEN_ANHALT", "SCHLESWIG_HOLSTEIN", "THUERINGEN"
];

function list(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function localizedText(value) {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.map(localizedText).filter(Boolean).join("\n").trim();
  if (!value || typeof value !== "object") return "";
  for (const key of ["deu", "de", "langDe", "text", "value", "title", "shortText", "longText", "content", "message"]) {
    if (value[key] != null) {
      const result = localizedText(value[key]);
      if (result) return result;
    }
  }
  return "";
}

function firstText(...values) {
  for (const value of values) {
    const text = localizedText(value);
    if (text) return text;
  }
  return "";
}

function collectNotices(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["disruptionCommunications", "disruption-communications", "results", "items", "content", "messages", "data", "_embedded"]) {
    if (Array.isArray(payload[key])) return payload[key];
    if (payload[key] && typeof payload[key] === "object") {
      const nested = collectNotices(payload[key]);
      if (nested.length) return nested;
    }
  }
  if (payload.disruptionCommunication && typeof payload.disruptionCommunication === "object") {
    return list(payload.disruptionCommunication);
  }
  if (payload.disruptionCommunicationID || payload.id) return [payload];
  return [];
}

function hasNoticeCollection(payload) {
  if (Array.isArray(payload)) return true;
  if (!payload || typeof payload !== "object") return false;
  return ["disruptionCommunications", "disruption-communications", "results", "items", "content", "messages", "data", "_embedded", "disruptionCommunication"]
    .some((key) => Object.prototype.hasOwnProperty.call(payload, key));
}

function lineLabel(value) {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (!value || typeof value !== "object") return "";
  return firstText(value.lineName, value.name, value.label, value.number, value.designation, value.displayName, value.line);
}

function affectedLines(notice) {
  const candidates = [
    notice.lines, notice.affectedLines, notice.lineRelations, notice.affectedProducts,
    notice.consumerHints && notice.consumerHints.lines,
    notice.affectedSubjects && notice.affectedSubjects.lines,
    notice.directAffected && notice.directAffected.lines,
    notice.corresponding && notice.corresponding.lines
  ];
  return [...new Set(candidates.flatMap((candidate) => list(candidate).map(lineLabel).filter(Boolean)))];
}

function validity(notice) {
  const period = notice.validityPeriod || notice.validity || notice.period || notice.event || {};
  return {
    start: firstText(notice.startDateTime, notice.timeStart, notice.startDate, notice.sDate, notice.validFrom, notice.start, period.startDateTime, period.timeStart, period.startDate, period.start, period.from),
    end: firstText(notice.endDateTime, notice.timeEnd, notice.endDate, notice.eDate, notice.validTo, notice.end, period.endDateTime, period.timeEnd, period.endDate, period.end, period.to)
  };
}

function sourceLink(notice) {
  const links = list(notice.links || notice.externalLinks);
  for (const link of links) {
    const url = firstText(link && (link.url || link.href));
    if (/^https:\/\/(www\.)?bahn\.de\//i.test(url)) return url;
  }
  return SOURCE_URL;
}

function normalizeNotice(notice) {
  const data = notice.disruptionCommunication || notice.communication
    ? { ...notice, ...(notice.disruptionCommunication || notice.communication) }
    : notice;
  const description = data.description || data.descriptions || {};
  const shortDescription = description.shortText || description.title || description.headline;
  const longDescription = description.longText || description.text || description.content;
  const headline = firstText(data.headline, data.title, data.subject, data.shortText, shortDescription);
  const text = firstText(data.text, data.message, data.longText, data.content, longDescription, description);
  const { start, end } = validity(data);
  return {
    id: firstText(data.disruptionCommunicationID, data.id, data.disruptionID),
    lines: affectedLines(data),
    headline,
    text,
    company: firstText(data.administrationName, data.transportCompany, data.company, data.operator),
    start,
    end,
    sourceUrl: sourceLink(data)
  };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method && req.method !== "GET") return res.status(405).json({ error: "method not allowed" });

  const clientId = process.env.DB_CLIENT_ID;
  const apiKey = process.env.DB_API_KEY;
  if (!clientId || !apiKey) {
    const now = Date.now();
    const items = MANUAL_SNAPSHOT.items.filter((item) => Date.parse(item.end) > now);
    return res.status(200).json({
      configured: true,
      sourceMode: "snapshot",
      snapshotAt: MANUAL_SNAPSHOT.snapshotAt,
      items,
      updatedAt: null
    });
  }

  const url = new URL(`${API_BASE}/disruption-communications/by-consumer-hints`);
  for (const state of STATES) url.searchParams.append("states", state);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "DB-Client-Id": clientId,
          "DB-Api-Key": apiKey,
          "User-Agent": "Bahn-Radar/1.1"
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`Deutsche Bahn API HTTP ${response.status}`);

    const payload = await response.json();
    if (!hasNoticeCollection(payload)) throw new Error("Unrecognized Deutsche Bahn API response format");
    const notices = collectNotices(payload);
    const items = notices
      .filter((notice) => notice && notice.active !== false && notice.isActive !== false)
      .map(normalizeNotice)
      .filter((item) => item.headline || item.text)
      .filter((item) => !item.end || !Number.isFinite(Date.parse(item.end)) || Date.parse(item.end) > Date.now())
      .filter((item, index, all) => !item.id || all.findIndex((candidate) => candidate.id === item.id) === index)
      .sort((a, b) => (a.start || "").localeCompare(b.start || ""));

    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=60");
    return res.status(200).json({ configured: true, sourceMode: "live", items, updatedAt: new Date().toISOString() });
  } catch (error) {
    return res.status(502).json({ error: String((error && error.message) || error).slice(0, 180) });
  }
};
