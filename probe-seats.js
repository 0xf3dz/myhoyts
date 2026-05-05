// Probe: from a Hoyts session, walk into the booking flow and report what
// information is exposed about seat availability (available vs total).
//
// Usage:
//   node probe-seats.js "QLD" "Redcliffe"
//   node probe-seats.js --url "https://www.hoyts.com.au/orders/tickets?cinemaId=REDCLF&sessionId=271106"
//
// The probe is verbose by design — it dumps DOM samples so you can see what
// selectors and attributes the seat map uses.

import { chromium } from "playwright";

const args = process.argv.slice(2);
const headed = args.includes("--headed");
const urlIdx = args.indexOf("--url");
const directUrl = urlIdx >= 0 ? args[urlIdx + 1] : null;
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--url");
const [stateArg, locationArg] = positional;

if (!directUrl && (!stateArg || !locationArg)) {
  console.error('Usage: node probe-seats.js "<state>" "<location>" [--headed]');
  console.error('   or: node probe-seats.js --url "<booking-url>" [--headed]');
  process.exit(1);
}

const SESSION_TIMES = "https://www.hoyts.com.au/session-times";

function header(s) {
  console.log(`\n=== ${s} ===`);
}

async function dumpVisibleControls(page, scopeSelector = "body") {
  const items = await page.evaluate((sel) => {
    const root = document.querySelector(sel) || document.body;
    const out = [];
    for (const el of root.querySelectorAll("button, a, input, select, [role='button'], [role='option'], [role='radio']")) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        cls: (el.getAttribute("class") || "").slice(0, 90),
        text: (el.innerText || el.value || "").trim().slice(0, 80),
        aria: el.getAttribute("aria-label"),
        disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
      });
    }
    const seen = new Set();
    return out.filter((c) => {
      const k = JSON.stringify(c);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, scopeSelector);
  console.log(JSON.stringify(items, null, 2));
}

async function navigateToFirstSession(page) {
  await page.goto(SESSION_TIMES, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  // Open cinema modal
  await page.locator(".widget__subheading--button:visible, .sessions-alert__button:visible").first().click();
  const modal = page.locator("#cinema-selection-modal");
  await modal.locator(".modal__panel").first().waitFor({ state: "visible" });

  const clear = modal.locator(".modal__clear-button");
  if (await clear.isVisible().catch(() => false)) {
    await clear.click().catch(() => {});
    await page.waitForTimeout(250);
  }

  await modal.locator(".modal__tab-button", { hasText: new RegExp(`^${stateArg}$`, "i") }).first().click();
  await page.waitForTimeout(300);
  await modal
    .locator(".modal__item-label")
    .filter({ hasText: new RegExp(`^\\s*${locationArg}\\s*$`, "i") })
    .first()
    .click();
  await modal.getByRole("button", { name: /save\s*&\s*browse/i }).first().click();
  await modal.waitFor({ state: "hidden" }).catch(() => {});

  await page.waitForSelector("li.movies-list__item .sessions__list a.session", { timeout: 20_000 });

  // Pick the first today-session link of the first movie
  const firstSession = page.locator("li.movies-list__item").first().locator(".sessions a.session").first();
  const movieTitle = await page.locator("li.movies-list__item").first().locator(".movies-list__heading").innerText();
  const sessionTime = await firstSession.locator(".session__time").innerText();
  const href = await firstSession.getAttribute("href");
  console.log(`→ Picking session: "${movieTitle.trim()}" at ${sessionTime.trim()}  (${href})`);
  await firstSession.click();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle").catch(() => {});
}

async function main() {
  const browser = await chromium.launch({ headless: !headed });
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    locale: "en-AU",
    timezoneId: "Australia/Sydney",
  });
  const page = await ctx.newPage();

  if (directUrl) {
    console.log(`→ Going directly to ${directUrl}`);
    await page.goto(directUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
  } else {
    await navigateToFirstSession(page);
  }

  header("Step 1: landed page URL");
  console.log(page.url());
  console.log("Title:", await page.title());

  header("Step 2: visible interactive controls on this page");
  await dumpVisibleControls(page);

  header("Step 3: try to advance to seat map");
  // Hoyts ticketing usually shows a ticket-type step first. Try to bump
  // adult quantity to 1 via any "+" / increment button, then continue.
  const candidates = [
    page.getByRole("button", { name: /^(continue|next|select seats|seat selection)$/i }),
    page.getByRole("button", { name: /\+/ }),
    page.locator("button:has-text('+')"),
    page.locator("[aria-label*='add' i], [aria-label*='increase' i], [aria-label*='increment' i]"),
  ];
  for (const c of candidates) {
    const count = await c.count().catch(() => 0);
    if (count > 0) {
      const first = c.first();
      const visible = await first.isVisible().catch(() => false);
      console.log(`candidate ${c} visible=${visible} count=${count}`);
    }
  }

  // Click any adult "+" twice to provoke selection, then look for a continue button.
  const plus = page.locator("button:has-text('+'):visible").first();
  if (await plus.isVisible().catch(() => false)) {
    console.log("→ clicking + to add a ticket");
    await plus.click().catch(() => {});
    await page.waitForTimeout(500);
  }

  const cont = page
    .getByRole("button", { name: /continue|next|seat\s*selection|select\s*seats/i })
    .first();
  if (await cont.isVisible().catch(() => false)) {
    console.log("→ clicking continue");
    await cont.click().catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1200);
  }

  header("Step 4: URL after advancing");
  console.log(page.url());

  header("Step 5: scan DOM for seat-related elements");
  const seatScan = await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll(
        "[class*='seat' i], [data-testid*='seat' i], [aria-label*='seat' i], svg [class*='seat' i], svg circle, svg rect, [class*='auditorium' i]",
      ),
    );
    // Sample up to 40 distinct (tag, class) pairs
    const samples = [];
    const seen = new Set();
    for (const el of candidates) {
      const key = `${el.tagName}|${el.getAttribute("class")}|${el.getAttribute("data-status") || ""}|${el.getAttribute("aria-label") || ""}`.slice(0, 200);
      if (seen.has(key)) continue;
      seen.add(key);
      const attrs = {};
      for (const a of el.getAttributeNames()) attrs[a] = el.getAttribute(a);
      samples.push({
        tag: el.tagName.toLowerCase(),
        attrs,
        text: (el.textContent || "").trim().slice(0, 40),
      });
      if (samples.length >= 40) break;
    }
    return { totalCandidates: candidates.length, samples };
  });
  console.log(`Total seat-ish elements: ${seatScan.totalCandidates}`);
  console.log(JSON.stringify(seatScan.samples, null, 2));

  header("Step 6: count by inferred status");
  const counts = await page.evaluate(() => {
    // Try a few common conventions and report counts for each.
    const reports = [];

    const byClass = (cls) => document.querySelectorAll(cls).length;

    reports.push({
      strategy: "class-substring on [class*='seat']",
      counts: {
        total: byClass("[class*='seat' i]:not([class*='seats' i])"),
        available: byClass("[class*='available' i]"),
        taken: byClass("[class*='taken' i],[class*='sold' i],[class*='occupied' i],[class*='booked' i],[class*='unavailable' i]"),
        selected: byClass("[class*='selected' i]"),
        accessible: byClass("[class*='wheelchair' i],[class*='accessible' i]"),
      },
    });

    // Tally by the modifier tail of every "seat--*" class
    const tally = {};
    for (const el of document.querySelectorAll("[class]")) {
      for (const c of el.classList) {
        const m = c.match(/^seat[-_]+([a-z0-9-]+)$/i) || c.match(/^seat--([a-z0-9-]+)$/i);
        if (m) tally[c] = (tally[c] || 0) + 1;
      }
    }
    reports.push({ strategy: "tally of seat-modifier classes", counts: tally });

    // Tally data-status / data-state attributes
    const ds = {};
    for (const el of document.querySelectorAll("[data-status],[data-state],[data-availability]")) {
      const v =
        el.getAttribute("data-status") ||
        el.getAttribute("data-state") ||
        el.getAttribute("data-availability");
      if (!v) continue;
      ds[v] = (ds[v] || 0) + 1;
    }
    reports.push({ strategy: "tally of data-status/state/availability", counts: ds });

    return reports;
  });
  console.log(JSON.stringify(counts, null, 2));

  header("Step 7: text snippets that mention seats");
  const seatSnippets = await page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = (n.nodeValue || "").trim();
      if (!t) continue;
      if (/(seat|available|sold|booked|capacity|of\s*\d+)/i.test(t) && t.length < 120) {
        out.push(t);
        if (out.length > 30) break;
      }
    }
    return out;
  });
  console.log(seatSnippets);

  header("Step 8: clean DOM count of seats by status");
  const domCounts = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll(".seating-map__button"));
    const total = buttons.length;
    const reserved = buttons.filter((b) => b.classList.contains("is-reserved")).length;
    const unavailable = buttons.filter((b) => b.classList.contains("is-unavailable")).length;
    const selected = buttons.filter((b) => b.classList.contains("is-selected")).length;
    const available = total - reserved - unavailable - selected;
    // Also derive per-seat status records to confirm
    const sample = buttons.slice(0, 10).map((b) => ({
      title: b.querySelector("svg")?.getAttribute("title") || null,
      classes: b.getAttribute("class"),
      disabled: b.hasAttribute("disabled"),
    }));
    return { total, reserved, unavailable, selected, available, sample };
  });
  console.log(JSON.stringify(domCounts, null, 2));

  header("Step 9: seat API capture (full JSON)");
  const seenUrls = new Set();
  let seatApiBody = null;
  let seatApiUrl = null;
  page.on("response", async (resp) => {
    const u = resp.url();
    if (!/\/ticket\/seats\//.test(u)) return;
    if (seenUrls.has(u)) return;
    seenUrls.add(u);
    try {
      const body = await resp.json().catch(() => null);
      if (!body) return;
      seatApiBody = body;
      seatApiUrl = u;
    } catch {}
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(2500);

  if (seatApiBody) {
    console.log(`URL: ${seatApiUrl}`);
    // Dump top-level shape
    console.log("Top-level keys:", Object.keys(seatApiBody));
    if (seatApiBody.areas) console.log("areas:", JSON.stringify(seatApiBody.areas));
    if (seatApiBody.rows) {
      const rowSummary = seatApiBody.rows.map((r) => ({
        row: r.name,
        seatCount: r.seats?.length || 0,
        sampleSeat: r.seats?.find((s) => s.typeId !== "gap") || null,
      }));
      console.log("rows summary:", JSON.stringify(rowSummary, null, 2));

      // Tally seat typeId values across all rows
      const tallies = {};
      const fieldKeys = new Set();
      for (const r of seatApiBody.rows) {
        for (const s of r.seats || []) {
          tallies[s.typeId] = (tallies[s.typeId] || 0) + 1;
          for (const k of Object.keys(s)) fieldKeys.add(k);
        }
      }
      console.log("typeId tally:", tallies);
      console.log("seat object keys observed:", [...fieldKeys]);
    }
  } else {
    console.log("(no seat API call captured)");
  }

  header("Step 10: SUMMARY");
  console.log(`DOM: ${domCounts.available} available / ${domCounts.total} total`);
  console.log(`     (${domCounts.reserved} reserved, ${domCounts.unavailable} unavailable, ${domCounts.selected} selected)`);

  if (headed) {
    console.log("\n(headed mode — leaving browser open for 30s)");
    await page.waitForTimeout(30_000);
  }
  await browser.close();
}

main().catch((err) => {
  console.error("Probe failed:", err);
  process.exit(1);
});
