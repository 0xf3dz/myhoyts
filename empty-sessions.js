// Lists today's movies whose sessions still have 100% of seats available
// (i.e. nobody has booked yet) at the given cinema.
//
// Usage:
//   node empty-sessions.js "QLD" "Redcliffe"
//   node empty-sessions.js "NSW" "Broadway" --headed
//
// "100% available" means no seat has sold:true. Structurally unavailable seats
// (e.g. permanently-blocked wheelchair-companion seats at some cinemas) are
// reported separately but do not disqualify a session.

import { chromium } from "playwright";

const args = process.argv.slice(2);
const headed = args.includes("--headed");
const positional = args.filter((a) => !a.startsWith("--"));
const [stateArg, locationArg] = positional;

if (!stateArg || !locationArg) {
  console.error('Usage: node empty-sessions.js "<state>" "<location>" [--headed]');
  process.exit(1);
}

const VALID_STATES = ["ACT", "NSW", "QLD", "SA", "VIC", "WA"];
const stateUpper = stateArg.toUpperCase();
if (!VALID_STATES.includes(stateUpper)) {
  console.error(`State must be one of: ${VALID_STATES.join(", ")}`);
  process.exit(1);
}

const SESSION_TIMES = "https://www.hoyts.com.au/session-times";
const SEATS_API = (cinemaId, sessionId) =>
  `https://apim.hoyts.com.au/au/ticketing/api/v1/ticket/seats/${cinemaId}/${sessionId}/`;

const escapeRegex = (s) => s.replace(/[/\\^$.*+?()[\]{}|]/g, "\\$&");

async function selectCinema(page, state, cinema) {
  const trigger = page
    .locator(".widget__subheading--button:visible, .sessions-alert__button:visible")
    .first();
  await trigger.waitFor({ state: "visible", timeout: 15_000 });
  await trigger.click();

  const modal = page.locator("#cinema-selection-modal");
  await modal.locator(".modal__panel").first().waitFor({ state: "visible" });

  const clear = modal.locator(".modal__clear-button");
  if (await clear.isVisible().catch(() => false)) {
    await clear.click().catch(() => {});
    await page.waitForTimeout(250);
  }

  await modal.locator(".modal__tab-button", { hasText: new RegExp(`^${state}$`, "i") }).first().click();
  await page.waitForTimeout(300);

  const label = modal
    .locator(".modal__item-label")
    .filter({ hasText: new RegExp(`^\\s*${escapeRegex(cinema)}\\s*$`, "i") })
    .first();

  if (!(await label.count())) {
    const available = await modal.locator(".modal__item-label").allInnerTexts();
    throw new Error(
      `Cinema "${cinema}" not in ${state}. Available: ${available.map((s) => s.trim()).filter(Boolean).join(", ")}`,
    );
  }
  await label.click();
  await page.waitForTimeout(300);
  await modal.getByRole("button", { name: /save\s*&\s*browse/i }).first().click();
  await modal.waitFor({ state: "hidden" }).catch(() => {});
}

async function extractTodayMovies(page) {
  await page.waitForSelector("ul.movies-list li.movies-list__item, .sessions-alert__heading", {
    timeout: 20_000,
  });
  return await page.evaluate(() => {
    return Array.from(document.querySelectorAll("li.movies-list__item")).map((item) => {
      const today = Array.from(item.querySelectorAll(".sessions")).find((b) =>
        /^today\b/i.test(b.querySelector(".sessions__date")?.innerText.trim() || ""),
      );
      const sessions = today
        ? Array.from(today.querySelectorAll("li.sessions__item"))
            .map((li) => {
              const a = li.querySelector("a.session");
              const href = a?.getAttribute("href") || null;
              if (!href) return null;
              let cinemaId = null;
              let sessionId = null;
              try {
                const u = new URL(href, "https://www.hoyts.com.au");
                cinemaId = u.searchParams.get("cinemaId");
                sessionId = u.searchParams.get("sessionId");
              } catch {}
              return {
                time: li.querySelector(".session__time")?.innerText.trim().toUpperCase() || null,
                attributes: Array.from(li.querySelectorAll(".session__attribute-name")).map((s) => s.innerText.trim()),
                tags: Array.from(li.querySelectorAll(".session__tag")).map((s) => s.innerText.trim()),
                cinemaId,
                sessionId,
                bookingUrl: href,
              };
            })
            .filter(Boolean)
        : [];

      return {
        title: item.querySelector(".movies-list__heading")?.innerText.trim() || null,
        movieUrl: item.querySelector(".movies-list__link")?.getAttribute("href") || null,
        rating: item.querySelector(".rating")?.getAttribute("title") || null,
        duration: item.querySelector(".movies-list__duration")?.innerText.trim() || null,
        sessions,
      };
    });
  });
}

function summarizeSeats(seatJson) {
  const rows = seatJson?.rows || [];
  let total = 0;
  let sold = 0;
  let unavailable = 0;
  for (const r of rows) {
    for (const s of r.seats || []) {
      if (s.typeId === "gap") continue;
      total += 1;
      if (s.sold === true) sold += 1;
      else if (s.unavailable === true) unavailable += 1;
    }
  }
  const bookable = total - unavailable;
  const available = bookable - sold;
  return {
    total,
    bookable,
    available,
    sold,
    unavailable,
    fullyOpen: bookable > 0 && sold === 0,
  };
}

async function fetchSeats(request, cinemaId, sessionId) {
  const resp = await request.get(SEATS_API(cinemaId, sessionId), {
    headers: { accept: "application/json" },
  });
  if (!resp.ok()) throw new Error(`seats API ${resp.status()} for ${cinemaId}/${sessionId}`);
  return await resp.json();
}

async function mapWithConcurrency(items, limit, fn) {
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

async function main() {
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    locale: "en-AU",
    timezoneId: "Australia/Sydney",
  });
  const page = await context.newPage();

  console.error(`→ Opening ${SESSION_TIMES}`);
  await page.goto(SESSION_TIMES, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  console.error(`→ Selecting ${stateUpper} / ${locationArg}`);
  await selectCinema(page, stateUpper, locationArg);
  await page.waitForLoadState("networkidle").catch(() => {});

  const movies = await extractTodayMovies(page);
  const allSessions = movies.flatMap((m) =>
    m.sessions
      .filter((s) => s.cinemaId && s.sessionId)
      .map((s) => ({ movieTitle: m.title, ...s })),
  );

  console.error(`→ Checking seat availability for ${allSessions.length} sessions`);
  const seatResults = await mapWithConcurrency(allSessions, 5, async (s) => {
    try {
      const json = await fetchSeats(context.request, s.cinemaId, s.sessionId);
      return { ...s, seats: summarizeSeats(json) };
    } catch (err) {
      return { ...s, seats: null, error: err.message };
    }
  });

  // Keep only sessions that are fully open, then group by movie.
  const byMovie = new Map();
  for (const r of seatResults) {
    if (!r.seats?.fullyOpen) continue;
    const m = movies.find((mm) => mm.title === r.movieTitle);
    if (!byMovie.has(r.movieTitle)) {
      byMovie.set(r.movieTitle, {
        title: m.title,
        movieUrl: m.movieUrl,
        rating: m.rating,
        duration: m.duration,
        sessions: [],
      });
    }
    byMovie.get(r.movieTitle).sessions.push({
      time: r.time,
      attributes: r.attributes,
      tags: r.tags,
      cinemaId: r.cinemaId,
      sessionId: r.sessionId,
      bookingUrl: r.bookingUrl,
      seats: r.seats,
    });
  }

  const output = {
    scrapedAt: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    state: stateUpper,
    location: locationArg,
    criterion: "no seats sold (sold === 0)",
    movieCount: byMovie.size,
    movies: [...byMovie.values()],
  };

  console.log(JSON.stringify(output, null, 2));
  await browser.close();
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
