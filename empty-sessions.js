// Lists today's sessions at a Hoyts cinema where no seats have been sold yet.
// Uses Hoyts's public JSON APIs directly — no browser automation.
//
// Usage:
//   node empty-sessions.js "QLD" "Redcliffe"
//
// "No seats sold" means session.sold === 0. Permanently-blocked seats
// (e.g. wheelchair-companion seats) are reported but don't disqualify.

const args = process.argv.slice(2);
const [stateArg, locationArg] = args;

if (!stateArg || !locationArg) {
  console.error('Usage: node empty-sessions.js "<state>" "<location>"');
  process.exit(1);
}

const VALID_STATES = ["ACT", "NSW", "QLD", "SA", "VIC", "WA"];
const STATE = stateArg.toUpperCase();
if (!VALID_STATES.includes(STATE)) {
  console.error(`State must be one of: ${VALID_STATES.join(", ")}`);
  process.exit(1);
}

const STATE_TZ = {
  ACT: "Australia/Sydney",
  NSW: "Australia/Sydney",
  QLD: "Australia/Brisbane",
  SA: "Australia/Adelaide",
  VIC: "Australia/Melbourne",
  WA: "Australia/Perth",
};

const log = process.stderr.isTTY ? (...a) => console.error(...a) : () => {};

const API = "https://apim.hoyts.com.au/au/cinemaapi/api";
const SEATS_API = (cinemaId, sessionId) =>
  `https://apim.hoyts.com.au/au/ticketing/api/v1/ticket/seats/${cinemaId}/${sessionId}/`;
const HOYTS_BASE = "https://www.hoyts.com.au";

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

function todayInTz(tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function findCinema(cinemas, state, query) {
  const q = query.trim().toLowerCase();
  const inState = cinemas.filter((c) => c.state === state);
  return (
    inState.find((c) => c.name.toLowerCase() === q) ||
    inState.find((c) => c.slug?.toLowerCase() === q) ||
    inState.find((c) => c.suburb?.toLowerCase() === q) ||
    inState.find((c) => c.name.toLowerCase().includes(q))
  );
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

function formatTime(localDateString) {
  // session.date looks like "2026-05-05T19:15:00" in cinema-local time
  const [, time] = localDateString.split("T");
  const [hh, mm] = time.split(":").map(Number);
  const h12 = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
  const ampm = hh >= 12 ? "PM" : "AM";
  return `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
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
  log(`→ Fetching cinemas + movies`);
  const [cinemas, movies] = await Promise.all([
    getJson(`${API}/cinemas`),
    getJson(`${API}/movies`),
  ]);

  const cinema = findCinema(cinemas, STATE, locationArg);
  if (!cinema) {
    const available = cinemas
      .filter((c) => c.state === STATE)
      .map((c) => c.name)
      .join(", ");
    throw new Error(
      `Cinema "${locationArg}" not in ${STATE}. Available: ${available}`,
    );
  }

  const today = todayInTz(STATE_TZ[STATE]);
  log(`→ ${cinema.name} (${cinema.id}) — ${today}`);

  const sessions = await getJson(`${API}/sessions/${cinema.id}`);
  const todayLive = sessions.filter(
    (s) => s.date?.startsWith(today) && !s.disabled,
  );
  log(`→ ${todayLive.length} live sessions today`);

  const seatResults = await mapWithConcurrency(todayLive, 5, async (s) => {
    try {
      const json = await getJson(SEATS_API(cinema.id, s.id));
      return { ...s, seats: summarizeSeats(json) };
    } catch (err) {
      return { ...s, seats: null, error: err.message };
    }
  });

  const movieByVistaId = new Map(movies.map((m) => [m.vistaId, m]));

  const byMovie = new Map();
  for (const r of seatResults) {
    if (!r.seats?.fullyOpen) continue;
    const mv = movieByVistaId.get(r.movieId);
    if (!byMovie.has(r.movieId)) {
      byMovie.set(r.movieId, {
        title: mv?.name || r.movieId,
        movieUrl: mv?.link ? `${HOYTS_BASE}${mv.link}` : null,
        rating: mv?.rating?.id || null,
        duration: mv?.duration ? `${mv.duration} min` : null,
        sessions: [],
      });
    }
    const link = r.link || `/orders/tickets?cinemaId=${cinema.id}&sessionId=${r.id}`;
    byMovie.get(r.movieId).sessions.push({
      time: formatTime(r.date),
      attributes: r.originalTags || [],
      tags: r.typeId === "XTREME" ? ["XtremeScreen"] : [],
      cinemaId: cinema.id,
      sessionId: r.id,
      bookingUrl: link.startsWith("http") ? link : `${HOYTS_BASE}${link}`,
      seats: r.seats,
    });
  }

  const output = {
    scrapedAt: new Date().toISOString(),
    date: today,
    state: STATE,
    location: locationArg,
    cinemaId: cinema.id,
    cinemaName: cinema.name,
    criterion: "no seats sold (sold === 0)",
    movieCount: byMovie.size,
    movies: [...byMovie.values()],
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
