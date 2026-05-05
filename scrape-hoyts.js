import { chromium } from "playwright";

const URL = "https://www.hoyts.com.au/session-times";

// CLI: node scrape-hoyts.js "<state>" "<location>" [--headed]
// Examples:
//   node scrape-hoyts.js "QLD" "Redcliffe"
//   node scrape-hoyts.js "NSW" "Broadway"
const args = process.argv.slice(2);
const headed = args.includes("--headed");
const positional = args.filter((a) => !a.startsWith("--"));
const [stateArg, locationArg] = positional;

if (!stateArg || !locationArg) {
  console.error('Usage: node scrape-hoyts.js "<state>" "<location>" [--headed]');
  console.error('Example: node scrape-hoyts.js "QLD" "Redcliffe"');
  process.exit(1);
}

const VALID_STATES = ["ACT", "NSW", "QLD", "SA", "VIC", "WA"];
const stateUpper = stateArg.toUpperCase();
if (!VALID_STATES.includes(stateUpper)) {
  console.error(`State must be one of: ${VALID_STATES.join(", ")} — got "${stateArg}"`);
  process.exit(1);
}

const todayISO = new Date().toISOString().slice(0, 10);

async function selectCinema(page, state, cinema) {
  // Open the cinema selection modal. Either trigger works depending on whether
  // any cinema is already selected; pick whichever is currently visible.
  const trigger = page
    .locator(
      ".widget__subheading--button:visible, .sessions-alert__button:visible",
    )
    .first();
  await trigger.waitFor({ state: "visible", timeout: 15_000 });
  await trigger.click();

  // The modal panel is the visibility-bearing element; the outer #cinema-selection-modal
  // wrapper stays mounted but display:none until opened.
  const modal = page.locator("#cinema-selection-modal");
  await modal
    .locator(".modal__panel")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });

  // Clear any pre-selected cinemas so we get a clean filter.
  const clear = modal.locator(".modal__clear-button");
  if (await clear.isVisible().catch(() => false)) {
    await clear.click().catch(() => {});
    await page.waitForTimeout(250);
  }

  // Pick the state tab.
  const stateTab = modal.locator(".modal__tab-button", {
    hasText: new RegExp(`^${state}$`, "i"),
  });
  await stateTab.first().click();
  await page.waitForTimeout(300);

  // Pick the cinema by visible label text (anchored, case-insensitive).
  const label = modal
    .locator(".modal__item-label")
    .filter({ hasText: new RegExp(`^\\s*${escapeRegex(cinema)}\\s*$`, "i") })
    .first();

  if (!(await label.count())) {
    const available = await modal
      .locator(".modal__item-label")
      .allInnerTexts();
    throw new Error(
      `Cinema "${cinema}" not found in ${state}. Available: ${available
        .map((s) => s.trim())
        .filter(Boolean)
        .join(", ")}`,
    );
  }
  await label.click();
  await page.waitForTimeout(300);

  // Confirm.
  await modal
    .getByRole("button", { name: /save\s*&\s*browse/i })
    .first()
    .click();

  // Modal closes and the movie list re-renders.
  await modal.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
}

function escapeRegex(s) {
  return s.replace(/[/\\^$.*+?()[\]{}|]/g, "\\$&");
}

async function extractMovies(page) {
  // Wait for the movies list, or for an explicit "no sessions" message.
  await page
    .waitForSelector("ul.movies-list li.movies-list__item, .sessions-alert__heading", {
      timeout: 20_000,
    })
    .catch(() => {});

  return await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll("li.movies-list__item"));
    return items.map((item) => {
      const titleEl = item.querySelector(".movies-list__heading");
      const linkEl = item.querySelector(".movies-list__link");
      const duration = item.querySelector(".movies-list__duration")?.innerText.trim() || null;
      const releaseDate = item.querySelector(".movies-list__release-date")?.innerText.trim() || null;
      const summary = item.querySelector(".movies-list__summary")?.innerText.trim() || null;
      const ratingEl = item.querySelector(".rating");
      const rating =
        ratingEl?.getAttribute("title") ||
        Array.from(ratingEl?.classList || [])
          .find((c) => c.startsWith("rating--"))
          ?.replace(/^rating--(au-)?/, "")
          .toUpperCase() ||
        null;

      // Sessions live in one or more `.sessions` blocks; each has a date heading
      // ("Today · Tuesday 5 May"). We only want today's.
      const sessionBlocks = Array.from(item.querySelectorAll(".sessions"));
      const todayBlock =
        sessionBlocks.find((b) =>
          /^today\b/i.test(b.querySelector(".sessions__date")?.innerText.trim() || ""),
        ) || null;

      const cinema = todayBlock?.querySelector(".sessions__heading")?.innerText.trim() || null;
      const dateLabel = todayBlock?.querySelector(".sessions__date")?.innerText.trim() || null;

      const sessions = todayBlock
        ? Array.from(todayBlock.querySelectorAll("li.sessions__item")).map((li) => {
            const a = li.querySelector("a.session");
            const href = a?.getAttribute("href") || null;
            const time = li.querySelector(".session__time")?.innerText.trim().toUpperCase() || null;
            const attributes = Array.from(li.querySelectorAll(".session__attribute-name"))
              .map((s) => s.innerText.trim())
              .filter(Boolean);
            const tags = Array.from(li.querySelectorAll(".session__tag"))
              .map((s) => s.innerText.trim())
              .filter(Boolean);

            let sessionId = null;
            let cinemaId = null;
            if (href) {
              try {
                const u = new URL(href, "https://www.hoyts.com.au");
                sessionId = u.searchParams.get("sessionId");
                cinemaId = u.searchParams.get("cinemaId");
              } catch {}
            }

            return { time, attributes, tags, sessionId, cinemaId, bookingUrl: href };
          })
        : [];

      return {
        title: titleEl?.innerText.trim() || null,
        movieUrl: linkEl?.getAttribute("href") || null,
        rating,
        duration,
        releaseDate,
        summary,
        cinema,
        dateLabel,
        sessions,
      };
    });
  });
}

async function main() {
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    locale: "en-AU",
    timezoneId: "Australia/Sydney",
  });
  const page = await context.newPage();

  console.error(`→ Opening ${URL}`);
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  console.error(`→ Selecting ${stateUpper} / ${locationArg}`);
  await selectCinema(page, stateUpper, locationArg);

  // Today is the default selected date — no extra click needed.
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1000);

  console.error("→ Extracting sessions");
  const movies = await extractMovies(page);
  // Drop movies that have no sessions for today (they appear in "Coming Soon" lists).
  const withSessions = movies.filter((m) => m.sessions.length > 0);

  const output = {
    scrapedAt: new Date().toISOString(),
    date: todayISO,
    state: stateUpper,
    location: locationArg,
    sourceUrl: page.url(),
    movieCount: withSessions.length,
    movies: withSessions,
  };

  console.log(JSON.stringify(output, null, 2));

  await browser.close();
}

main().catch((err) => {
  console.error("Scrape failed:", err);
  process.exit(1);
});
