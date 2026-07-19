#!/usr/bin/env node
// Agentic-coding commit breakdown for jonatw's PUBLIC repos, last N days.
// Classifies every commit into: human / Claude Code / fleet bots / CI-Dependabot / collaborators.
// Renders a self-hosted SVG (metrics/agentic-coding.svg) — no third-party services, never camo-breaks.
// Runs locally (eagle token) or in GitHub Actions (GITHUB_TOKEN). Public repos only → reproducible, no private leak.
import { writeFileSync, mkdirSync } from "node:fs";
import https from "node:https";

const USER = "jonatw";
const DAYS = 90;
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const SINCE = new Date(Date.now() - DAYS * 86400e3).toISOString();

function api(path) {
  return new Promise((res) => {
    https.get({ hostname: "api.github.com", path, headers: {
      "User-Agent": "agentic-stats", "Accept": "application/vnd.github+json",
      ...(TOKEN ? { Authorization: "token " + TOKEN } : {}),
    }}, (r) => {
      let d = ""; r.on("data", (c) => (d += c));
      r.on("end", () => { try { res({ status: r.statusCode, body: JSON.parse(d) }); } catch { res({ status: r.statusCode, body: null }); } });
    }).on("error", () => res({ status: 0, body: null }));
  });
}

const CATS = {
  human:  { label: "Jonathan (human)",  color: "#58a6ff" },
  claude: { label: "Claude Code",       color: "#d97757" },
  fleet:  { label: "Fleet agents",      color: "#a371f7" },
  ci:     { label: "CI / Dependabot",   color: "#3fb950" },
  collab: { label: "Collaborators",     color: "#8b949e" },
};

function classify(c) {
  const login = (c.author && c.author.login) || "";
  const msg = c.commit.message || "";
  const email = ((c.commit.author && c.commit.author.email) || "").toLowerCase();
  const name = (c.commit.author && c.commit.author.name) || "";
  if (["dependabot[bot]","dependabot-preview[bot]","github-actions[bot]","renovate[bot]","github-actions"].includes(login)) return "ci";
  if (/\[bot\]$/.test(login) || /@clawd\.ai$/.test(email) || name === "Clawdbot") return "fleet";
  if (/Co-Authored-By:\s*Claude/i.test(msg) || /noreply@anthropic\.com/.test(email)) return "claude";
  if (login === USER || /jona\.tw$/.test(email) || /jonatw/.test(email) || name === "Jonathan Huang") return "human";
  return "collab";
}

function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}

function svg(counts, total) {
  const W = 760, order = ["claude","human","fleet","ci","collab"];
  const agent = counts.claude + counts.fleet;
  const agentPct = total ? (100 * agent / total).toFixed(1) : "0";
  const barX = 40, barW = W - 80, barY = 150, barH = 26;
  let x = barX, segs = "";
  for (const k of order) {
    const w = total ? (counts[k] / total) * barW : 0;
    if (w > 0) segs += `<rect x="${x.toFixed(2)}" y="${barY}" width="${w.toFixed(2)}" height="${barH}" fill="${CATS[k].color}"/>`;
    x += w;
  }
  // fixed 2-column grid — never overflows
  const col = [barX, barX + 360], rowH = 26, ly0 = barY + barH + 30;
  let legend = "";
  order.forEach((k, i) => {
    const pct = total ? (100 * counts[k] / total).toFixed(1) : "0";
    const txt = `${CATS[k].label}  ${pct}% (${counts[k]})`;
    const cx = col[i % 2], cy = ly0 + Math.floor(i / 2) * rowH;
    legend += `<circle cx="${cx + 5}" cy="${cy - 4}" r="5" fill="${CATS[k].color}"/>` +
              `<text x="${cx + 16}" y="${cy}" font-size="13" fill="#c9d1d9" font-family="Segoe UI,Helvetica,Arial,sans-serif">${esc(txt)}</text>`;
  });
  const h = ly0 + Math.ceil(order.length / 2) * rowH + 12;
  return `<svg width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" xmlns="http://www.w3.org/2000/svg" role="img">
<rect x="0.5" y="0.5" width="${W-1}" height="${h-1}" rx="10" fill="#0d1117" stroke="#30363d"/>
<text x="40" y="42" font-size="18" font-weight="600" fill="#e6edf3" font-family="Segoe UI,Helvetica,Arial,sans-serif">Who writes my code</text>
<text x="40" y="64" font-size="12" fill="#8b949e" font-family="Segoe UI,Helvetica,Arial,sans-serif">commits across public repos · last ${DAYS} days · ${total} commits</text>
<text x="40" y="118" font-size="44" font-weight="700" fill="#d97757" font-family="Segoe UI,Helvetica,Arial,sans-serif">${agentPct}%</text>
<text x="${40 + agentPct.length*27 + 22}" y="118" font-size="15" fill="#c9d1d9" font-family="Segoe UI,Helvetica,Arial,sans-serif">of my commits are</text>
<text x="${40 + agentPct.length*27 + 22}" y="136" font-size="15" font-weight="600" fill="#e6edf3" font-family="Segoe UI,Helvetica,Arial,sans-serif">agent-driven 🤖</text>
${segs}
<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="4" fill="none" stroke="#30363d"/>
${legend}
</svg>`;
}

(async () => {
  let repos = [], page = 1;
  while (true) {
    const r = await api(`/users/${USER}/repos?per_page=100&type=owner&page=${page}`);
    if (!Array.isArray(r.body)) break;
    repos = repos.concat(r.body);
    if (r.body.length < 100) break; page++;
  }
  repos = repos.filter((r) => !r.fork && !r.private);
  const counts = { human: 0, claude: 0, fleet: 0, ci: 0, collab: 0 };
  let total = 0;
  for (const repo of repos) {
    let p = 1;
    while (true) {
      const r = await api(`/repos/${repo.full_name}/commits?since=${SINCE}&per_page=100&page=${p}`);
      if (r.status !== 200 || !Array.isArray(r.body) || r.body.length === 0) break;
      for (const c of r.body) { counts[classify(c)]++; total++; }
      if (r.body.length < 100) break; p++; if (p > 20) break;
    }
  }
  mkdirSync("metrics", { recursive: true });
  writeFileSync("metrics/agentic-coding.svg", svg(counts, total));
  writeFileSync("metrics/agentic-coding.json", JSON.stringify({ generated: new Date().toISOString(), days: DAYS, total, counts }, null, 2));
  console.log("repos:", repos.length, "total:", total);
  console.log(counts);
})();
