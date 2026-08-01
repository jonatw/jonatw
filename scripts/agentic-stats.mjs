#!/usr/bin/env node
// Agentic-coding breakdown for jonatw's repos (incl. private), last N days.
//
// WHAT THIS MEASURES — the axis is *autonomy*, not "which tool typed the characters":
//   solo      : commit authored by me, no agent involved
//   paired    : commit authored by me with Claude as co-author (git's own model:
//               Author = me, Co-Authored-By = Claude — so it is my commit)
//   delegated : commit/PR/issue produced by a fleet agent running autonomously;
//               I review and merge, but the work is the fleet's
//   ci        : Dependabot / Actions / Renovate
//   collab    : external contributors — counted, then excluded from the totals
//
// PRIVACY INVARIANTS (mirror flightdeck's redaction policy — roles fly, names don't):
//   - no repository names are ever written to the SVG/JSON
//   - no agent account logins (jonatw-*[bot] etc.) are ever written to the SVG/JSON
//   - only aggregate counts leave this script
//
// Renders a self-hosted SVG (metrics/agentic-coding.svg) — no third-party services.
//
// Data sources, and why:
//   commits  REST    /repos/{r}/commits       — need the Co-Authored-By trailer + author email
//   PRs      GraphQL pullRequests             — additions/deletions come free in the list query
//   issues   GraphQL issues                   — separate connection from PRs (unlike REST)
//   lines    REST    /repos/{r}/commits/{sha} — list-commits carries NO stats, so one GET per
//                                               commit, memoised in metrics/commit-stats-cache.json
//                                               so steady state is only the day's new commits
//
// Env: GH_TOKEN (read-only PAT with private-repo access). DAYS / MAX_REPOS / LOC_BUDGET override.

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import https from "node:https";

const USER = "jonatw";
const DAYS = +(process.env.DAYS || 90);
const MAX_REPOS = +(process.env.MAX_REPOS || 0);      // 0 = all; used for cheap smoke tests
const LOC_BUDGET = +(process.env.LOC_BUDGET || 2500); // max NEW per-commit stat fetches per run
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const SINCE = new Date(Date.now() - DAYS * 86400e3).toISOString();
const CACHE_PATH = "metrics/commit-churn-cache.json";

// Files that are committed but not *written* — generated reports, scraped data,
// transcripts, lockfiles, vendored trees, binaries. Without this filter the line
// count measures how much DATA I commit, not how much code gets written: one
// research repo alone contributed 260k of 270k lines from archived HTML reports
// and YouTube transcripts. Measured effect — data-heavy repo keeps 3%, pure-code
// repo keeps 100%. Tune this list rather than the totals.
const GENERATED = [
  /(^|\/)(node_modules|dist|build|vendor|\.venv|__pycache__)\//,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|uv\.lock)$/,
  /(^|\/)(archive|transcripts|snapshots|fixtures|data)\//,
  /\.(txt|csv|tsv|json|jsonl|ndjson|html|svg|min\.js|map|lock|pdf|png|jpg|jpeg|gif|webp|ipynb)$/i,
];
const isGenerated = (path) => GENERATED.some((re) => re.test(path));

const CI_LOGINS = new Set([
  "dependabot", "dependabot[bot]", "dependabot-preview[bot]",
  "github-actions", "github-actions[bot]", "renovate", "renovate[bot]",
]);

// ---------------------------------------------------------------- http

function request(path, { method = "GET", body = null } = {}) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: "api.github.com", path, method,
      headers: {
        "User-Agent": "agentic-stats",
        Accept: "application/vnd.github+json",
        ...(TOKEN ? { Authorization: "token " + TOKEN } : {}),
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    }, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(d); } catch { /* non-JSON: 502 html, etc. */ }
        resolve({ status: r.statusCode, body: parsed });
      });
    });
    req.on("error", () => resolve({ status: 0, body: null }));
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retries 5xx and secondary-rate-limit responses.
async function api(path, opts = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await request(path, opts);
    if (r.status === 403 && /rate limit|abuse/i.test(JSON.stringify(r.body || ""))) {
      await sleep(2000 * (i + 1));
      continue;
    }
    if (r.status >= 500 || r.status === 0) {
      await sleep(1000 * (i + 1));
      continue;
    }
    return r;
  }
  return { status: 0, body: null };
}

async function gql(query, variables = {}) {
  const r = await api("/graphql", { method: "POST", body: { query, variables } });
  // Auth failures come back as HTTP 401 with {message}, not as an `errors` array,
  // so checking only `errors` yields "cannot read property of undefined" further
  // downstream instead of "Bad credentials".
  if (r.status !== 200 || !r.body || r.body.errors || !r.body.data) {
    const msg =
      r.body?.errors?.map((e) => e.message).join("; ") ||
      r.body?.message ||
      `HTTP ${r.status}`;
    throw new Error("GraphQL: " + msg);
  }
  return r.body.data;
}

// Bounded-concurrency map — keeps us under GitHub's secondary rate limits.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------- classify

// Commits: we can see the author identity AND the Co-Authored-By trailer.
// Order matters — a fleet agent's commit also carries the Claude trailer, and it
// must land in `delegated`, not `paired`. The bot check therefore runs first.
function classifyCommit(c) {
  const login = c.author?.login || "";
  const msg = c.commit?.message || "";
  const email = (c.commit?.author?.email || "").toLowerCase();
  const name = c.commit?.author?.name || "";

  if (CI_LOGINS.has(login)) return "ci";
  if (/\[bot\]$/.test(login) || /@clawd\.ai$/.test(email) || name === "Clawdbot") return "delegated";

  const mine =
    login === USER ||
    /jona\.tw$/.test(email) ||
    /(^|[^a-z])jonatw($|[^a-z])/.test(email) ||
    name === "Jonathan Huang" ||
    name === "Jonathan";
  if (!mine) return "collab";

  const paired = /Co-Authored-By:\s*Claude/i.test(msg) || /noreply@anthropic\.com/.test(email);
  return paired ? "paired" : "solo";
}

// PRs / issues: GitHub records only *who opened it*. There is no trailer to read,
// so these cannot be split solo-vs-paired — the SVG footnote says so rather than
// silently implying every PR I opened was hand-written.
// NB: GraphQL Bot logins carry no "[bot]" suffix (REST does) — use __typename.
function classifyActor(a) {
  if (!a) return "collab"; // deleted account ("ghost")
  const login = a.login || "";
  if (CI_LOGINS.has(login)) return "ci";
  if (a.__typename === "Bot") return "delegated";
  if (login === USER) return "mine";
  return "collab";
}

// ---------------------------------------------------------------- fetch

async function listRepos() {
  const q = `query($cursor:String){
    viewer{ repositories(first:50, after:$cursor, ownerAffiliations:OWNER, isFork:false,
                         orderBy:{field:PUSHED_AT,direction:DESC}){
      pageInfo{ hasNextPage endCursor }
      nodes{ nameWithOwner owner{ login } isFork }
    }}}`;
  const out = [];
  let cursor = null;
  for (;;) {
    const d = await gql(q, { cursor });
    const c = d.viewer.repositories;
    out.push(...c.nodes.filter((r) => !r.isFork && r.owner.login === USER).map((r) => r.nameWithOwner));
    if (!c.pageInfo.hasNextPage) break;
    cursor = c.pageInfo.endCursor;
  }
  return MAX_REPOS ? out.slice(0, MAX_REPOS) : out;
}

// One repo's PRs and issues, paginated, stopping as soon as we're past the window.
// Page sizes are deliberately small: deep nesting (25 repos x 100 x 100) returns 502.
async function fetchRepoIssuesAndPRs(nameWithOwner) {
  const [owner, name] = nameWithOwner.split("/");
  const prs = [];
  const issues = [];

  // Outer page dropped to 25 because reviews are nested: 25 x 20 = 500 nodes per
  // query. Deep nesting is what returns 502 (25 repos x 100 x 100 did).
  const prQ = `query($o:String!,$n:String!,$cursor:String){
    repository(owner:$o,name:$n){ pullRequests(first:25, after:$cursor,
      orderBy:{field:CREATED_AT,direction:DESC}){
      pageInfo{ hasNextPage endCursor }
      nodes{ createdAt additions deletions merged author{ login __typename }
             reviews(first:20){ nodes{ createdAt state author{ login __typename } } } }
    }}}`;
  const isQ = `query($o:String!,$n:String!,$cursor:String){
    repository(owner:$o,name:$n){ issues(first:50, after:$cursor,
      orderBy:{field:CREATED_AT,direction:DESC}){
      pageInfo{ hasNextPage endCursor }
      nodes{ createdAt author{ login __typename } }
    }}}`;

  const errors = [];
  for (const [query, sink, key] of [[prQ, prs, "pullRequests"], [isQ, issues, "issues"]]) {
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      let d;
      try {
        d = await gql(query, { o: owner, n: name, cursor });
      } catch (e) {
        // NEVER swallow this. A token without Issues/Pull-requests read permission
        // fails here on every repo, and a silent skip renders a chart that looks
        // fine while reporting ~20% of reality. main() aborts the run instead.
        errors.push(`${key}: ${e.message}`);
        break;
      }
      const conn = d.repository?.[key];
      if (!conn) break;
      const fresh = conn.nodes.filter((x) => x.createdAt >= SINCE);
      sink.push(...fresh);
      // nodes are CREATED_AT DESC, so the first page containing anything older ends it
      if (fresh.length < conn.nodes.length || !conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
  }

  const reviews = prs.flatMap((p) => (p.reviews?.nodes || []).filter((r) => r.createdAt >= SINCE));
  return { prs, issues, reviews, errors };
}

// Comments on issues AND pull requests, repo-wide in one paginated call each —
// far cheaper than walking every thread. `since` filters on updated_at, so the
// created_at window is applied here.
//   /issues/comments : conversation comments on both issues and PRs
//   /pulls/comments  : inline review comments on a diff
async function fetchRepoComments(nameWithOwner) {
  const out = [];
  const errors = [];
  for (const kind of ["issues", "pulls"]) {
    for (let p = 1; p <= 20; p++) {
      const r = await api(`/repos/${nameWithOwner}/${kind}/comments?since=${SINCE}&per_page=100&page=${p}`);
      // Same trap as the GraphQL path: a token without Issues/Pull-requests read
      // gets 403/404 here and an unguarded loop would read that as "no comments".
      // 404 on page 1 can also mean the feature is disabled, so only flag 401/403.
      if (r.status === 401 || r.status === 403) { errors.push(`${kind}/comments: HTTP ${r.status}`); break; }
      if (r.status !== 200 || !Array.isArray(r.body) || r.body.length === 0) break;
      for (const c of r.body) if (c.created_at >= SINCE) out.push(c);
      if (r.body.length < 100) break;
    }
  }
  return { comments: out, errors };
}

async function fetchRepoCommits(nameWithOwner) {
  const out = [];
  for (let p = 1; p <= 20; p++) {
    const r = await api(`/repos/${nameWithOwner}/commits?since=${SINCE}&per_page=100&page=${p}`);
    if (r.status !== 200 || !Array.isArray(r.body) || r.body.length === 0) break;
    out.push(...r.body);
    if (r.body.length < 100) break;
  }
  return out;
}

// ---------------------------------------------------------------- lines

function loadCache() {
  if (!existsSync(CACHE_PATH)) return {};
  try { return JSON.parse(readFileSync(CACHE_PATH, "utf8")); } catch { return {}; }
}

// Per-commit source churn. The list endpoint carries no stats, so this is one GET
// per commit — memoised by SHA, so only the day's new commits cost anything. The
// same response already carries files[], so filtering generated files out is free.
// Caveat: files[] is capped at 300 entries per commit, so a commit touching more
// than that undercounts — it errs small, which is the safe direction here.
async function fetchLineStats(commitsByRepo, cache) {
  const wanted = [];
  for (const { repo, commits } of commitsByRepo) {
    for (const c of commits) if (!cache[c.sha]) wanted.push({ repo, sha: c.sha });
  }
  const budgeted = wanted.slice(0, LOC_BUDGET);
  let fetched = 0;

  await pool(budgeted, 6, async ({ repo, sha }) => {
    const r = await api(`/repos/${repo}/commits/${sha}`);
    if (r.status === 200 && Array.isArray(r.body?.files)) {
      let add = 0, del = 0;
      for (const f of r.body.files) {
        if (isGenerated(f.filename || "")) continue;
        add += f.additions | 0;
        del += f.deletions | 0;
      }
      cache[sha] = [add, del];
      fetched++;
    } else {
      cache[sha] = [0, 0]; // unresolvable (diff too large / gone) — memoise so we stop retrying
    }
  });

  return { fetched, deferred: wanted.length - budgeted.length };
}

// ---------------------------------------------------------------- svg

// Legend wording is load-bearing. On the commits/lines rows blue is "me without an
// agent" and orange is "me with Claude"; on the PRs/issues rows GitHub records no
// pairing at all, so everything I opened has to go in the blue segment. Labelling
// blue "Solo" would therefore claim those PRs were hand-written. Labelling it "Me"
// and orange "+ Claude (paired)" reads correctly on every row: blue = me, orange =
// me, plus Claude.
const CATS = {
  solo:      { label: "Me",                   color: "#58a6ff" },
  paired:    { label: "+ Claude (paired)",    color: "#d97757" },
  delegated: { label: "Fleet — autonomous",   color: "#a371f7" },
  ci:        { label: "CI / Dependabot",      color: "#3fb950" },
};
const ORDER = ["solo", "paired", "delegated", "ci"];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (n) => n.toLocaleString("en-US");
const pct = (n, t) => (t ? (100 * n) / t : 0);
const F = 'font-family="Segoe UI,Helvetica,Arial,sans-serif"';

function svg(rows, head) {
  const W = 760;
  const labelX = 40, barX = 150, barW = 400, valX = barX + barW + 14, barH = 16, rowGap = 34;
  const rowY0 = 200;

  let body = "";
  rows.forEach((row, i) => {
    const y = rowY0 + i * rowGap;
    const total = ORDER.reduce((s, k) => s + (row.counts[k] || 0), 0);
    let x = barX;
    let segs = "";
    for (const k of ORDER) {
      const w = total ? ((row.counts[k] || 0) / total) * barW : 0;
      if (w > 0.4) segs += `<rect x="${x.toFixed(2)}" y="${y}" width="${w.toFixed(2)}" height="${barH}" fill="${CATS[k].color}"/>`;
      x += w;
    }
    body +=
      `<text x="${labelX}" y="${y + 8}" font-size="13" font-weight="600" fill="#c9d1d9" ${F}>${esc(row.label)}</text>` +
      `<text x="${labelX}" y="${y + 22}" font-size="10" fill="#6e7681" ${F}>${esc(row.sub)}</text>` +
      segs +
      `<rect x="${barX}" y="${y}" width="${barW}" height="${barH}" rx="3" fill="none" stroke="#30363d"/>` +
      `<text x="${valX}" y="${y + 13}" font-size="12" fill="#8b949e" ${F}>${esc(row.value)}</text>`;
  });

  const legY = rowY0 + rows.length * rowGap + 18;
  let legend = "";
  ORDER.forEach((k, i) => {
    const cx = labelX + (i % 2) * 360;
    const cy = legY + Math.floor(i / 2) * 20;
    legend +=
      `<circle cx="${cx + 5}" cy="${cy - 4}" r="5" fill="${CATS[k].color}"/>` +
      `<text x="${cx + 16}" y="${cy}" font-size="12" fill="#c9d1d9" ${F}>${esc(CATS[k].label)}</text>`;
  });

  const noteY = legY + Math.ceil(ORDER.length / 2) * 20 + 16;
  // ~146 chars at 10px already runs to x≈740 of 760 — extra notes must wrap to
  // their own line rather than extend this one off the canvas.
  const notes = [
    "PRs and issues show who opened them — GitHub records no pairing there.",
    "The fleet opens most of the tickets; it writes a smaller share of the code.",
    "Line counts exclude lockfiles, vendored trees, generated reports and committed data.",
    ...(head.coverageNote ? [head.coverageNote] : []),
  ];
  const noteSvg = notes
    .map((t, i) => `<text x="${labelX}" y="${noteY + i * 14}" font-size="10" fill="#6e7681" ${F}>${esc(t)}</text>`)
    .join("");
  const H = noteY + (notes.length - 1) * 14 + 22;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Who ships the code — ${head.minePct}% of commits authored by me, ${head.fleetPct}% shipped autonomously by my agent fleet">
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="#0d1117" stroke="#30363d"/>
<text x="40" y="42" font-size="18" font-weight="600" fill="#e6edf3" ${F}>Who ships the code</text>
<text x="40" y="62" font-size="11" fill="#8b949e" ${F}>last ${DAYS} days · every repo I own, public and private · ${fmt(head.commits)} commits</text>

<text x="40" y="122" font-size="40" font-weight="700" fill="#58a6ff" ${F}>${head.minePct}%</text>
<text x="40" y="144" font-size="12" fill="#8b949e" ${F}>authored by me</text>
<text x="164" y="112" font-size="13" fill="#c9d1d9" ${F}>${head.pairedPct}% of it written pairing with Claude —</text>
<text x="164" y="132" font-size="13" fill="#c9d1d9" ${F}>my hands on the controls, every turn.</text>

<text x="470" y="122" font-size="40" font-weight="700" fill="#a371f7" ${F}>${head.fleetPct}%</text>
<text x="470" y="144" font-size="12" fill="#8b949e" ${F}>shipped by the fleet</text>
<text x="470" y="162" font-size="11" fill="#6e7681" ${F}>autonomous — I review and merge</text>

${body}
${legend}
${noteSvg}
</svg>`;
}

// ---------------------------------------------------------------- main

(async () => {
  if (!TOKEN) console.warn("! no GH_TOKEN — private repos and GraphQL will be unavailable");

  const repos = await listRepos();
  console.log(`repos: ${repos.length}`);

  // commits (REST) --------------------------------------------------
  const commitsByRepo = await pool(repos, 4, async (repo) => ({ repo, commits: await fetchRepoCommits(repo) }));
  const commitCat = new Map(); // sha -> category
  const commits = { solo: 0, paired: 0, delegated: 0, ci: 0, collab: 0 };
  for (const { commits: list } of commitsByRepo) {
    for (const c of list) {
      const cat = classifyCommit(c);
      commits[cat]++;
      commitCat.set(c.sha, cat);
    }
  }

  // lines (REST per-SHA, memoised) ----------------------------------
  const cache = loadCache();
  const { fetched, deferred } = await fetchLineStats(commitsByRepo, cache);
  const lines = { solo: 0, paired: 0, delegated: 0, ci: 0, collab: 0 };
  let linesAdd = 0, linesDel = 0, covered = 0, coverable = 0;
  for (const { commits: list } of commitsByRepo) {
    for (const c of list) {
      const cat = commitCat.get(c.sha);
      const st = cache[c.sha];
      coverable++;
      if (!st) continue;
      covered++;
      lines[cat] += st[0] + st[1];
      if (cat !== "collab") { linesAdd += st[0]; linesDel += st[1]; }
    }
  }

  // PRs + issues + reviews (GraphQL), comments (REST) ----------------
  const zero = () => ({ solo: 0, paired: 0, delegated: 0, ci: 0, collab: 0 });
  const prsIssues = await pool(repos, 4, (repo) => fetchRepoIssuesAndPRs(repo));
  const comments = await pool(repos, 4, (repo) => fetchRepoComments(repo));

  // A permission-starved token fails every per-repo issues/pullRequests query and
  // would otherwise publish a chart showing ~20% of reality. Go red instead.
  const failed = [...prsIssues, ...comments].filter((r) => r.errors.length);
  if (failed.length) {
    const sample = [...new Set([...prsIssues, ...comments].flatMap((r) => r.errors))].slice(0, 3);
    console.error(`\n${failed.length} repo queries failed (of ${repos.length} repos x 2 passes):`);
    for (const s of sample) console.error("  " + s);
    console.error("\nIf this is the daily Action, STATS_TOKEN most likely lacks");
    console.error("'Issues: Read-only' and 'Pull requests: Read-only'. Commits come");
    console.error("from Contents, which is why they still look right.\n");
    throw new Error(`${failed.length} repos returned no issue/PR data`);
  }

  const prs = zero(), issues = zero(), reviews = zero(), discussion = zero();
  // "mine" lands in the `solo` slot purely as the "by me" bar segment — the
  // footnote states these carry no pairing signal at all.
  const bump = (o, actor) => { const c = classifyActor(actor); o[c === "mine" ? "solo" : c]++; };
  for (const { prs: p, issues: i, reviews: v } of prsIssues) {
    for (const x of p) bump(prs, x.author);
    for (const x of i) bump(issues, x.author);
    for (const x of v) bump(reviews, x.author);
  }
  for (const { comments: list } of comments) {
    // REST exposes the actor as user.type ("Bot"/"User"); GraphQL uses __typename.
    for (const c of list) bump(discussion, c.user && { login: c.user.login, __typename: c.user.type });
  }

  // totals -----------------------------------------------------------
  const shown = (o) => ORDER.reduce((s, k) => s + o[k], 0);
  const cTotal = shown(commits);
  const mineTotal = commits.solo + commits.paired;
  const head = {
    commits: cTotal,
    minePct: Math.round(pct(mineTotal, cTotal)),
    // relative to MY commits, not to all of them — the headline reads "…% of it",
    // and "it" is the share I just claimed on the line above.
    pairedPct: Math.round(pct(commits.paired, mineTotal)),
    fleetPct: Math.round(pct(commits.delegated, cTotal)),
  };

  const coveragePct = coverable ? Math.round((100 * covered) / coverable) : 0;
  const rows = [
    { label: "Commits",       sub: "who authored them", counts: commits, value: fmt(cTotal) },
    { label: "Lines",         sub: "source lines only",  counts: lines,   value: `+${fmt(linesAdd)} / −${fmt(linesDel)}` },
    { label: "Pull requests", sub: "who opened them",   counts: prs,     value: fmt(shown(prs)) },
    { label: "Issues",        sub: "who opened them",   counts: issues,  value: fmt(shown(issues)) },
    { label: "Reviews",       sub: "who reviewed",      counts: reviews, value: fmt(shown(reviews)) },
    { label: "Discussion",    sub: "who commented",     counts: discussion, value: fmt(shown(discussion)) },
  ];

  head.coverageNote = coveragePct >= 99 ? "" : `Line counts measured on ${coveragePct}% of commits; the rest resolve on the next run.`;

  mkdirSync("metrics", { recursive: true });
  writeFileSync("metrics/agentic-coding.svg", svg(rows, head));

  // Prune the cache to the current window so the committed file stays bounded.
  const live = {};
  for (const sha of commitCat.keys()) if (cache[sha]) live[sha] = cache[sha];
  writeFileSync(CACHE_PATH, JSON.stringify(live));

  const pick = (o) => Object.fromEntries(ORDER.map((k) => [k, o[k]]));
  writeFileSync("metrics/agentic-coding.json", JSON.stringify({
    generated: new Date().toISOString(),
    days: DAYS,
    commits: { total: cTotal, counts: pick(commits) },
    lines: { added: linesAdd, removed: linesDel, coverage_pct: coveragePct, counts: pick(lines) },
    pull_requests: { total: shown(prs), counts: pick(prs) },
    issues: { total: shown(issues), counts: pick(issues) },
    reviews: { total: shown(reviews), counts: pick(reviews) },
    discussion: { total: shown(discussion), counts: pick(discussion) },
    collaborators_excluded: {
      commits: commits.collab, pull_requests: prs.collab, issues: issues.collab,
      reviews: reviews.collab, discussion: discussion.collab,
    },
  }, null, 2));

  console.log(`commits ${cTotal} | lines +${linesAdd}/-${linesDel} (${coveragePct}% measured) | prs ${shown(prs)} | issues ${shown(issues)} | reviews ${shown(reviews)} | comments ${shown(discussion)}`);
  console.log(`line-stat fetches: ${fetched} new${deferred ? `, ${deferred} deferred to next run` : ""}`);
  console.log(commits);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
