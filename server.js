// Tiny dependency-free server. Serves index.html and exposes /api/search
// which runs empty-sessions.js and returns just the movie titles.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const ROOT = dirname(fileURLToPath(import.meta.url));

function runEmptySessions(state, location) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [join(ROOT, "empty-sessions.js"), state, location], {
      cwd: ROOT,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `exit ${code}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`bad JSON from scraper: ${e.message}`));
      }
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/") {
    const html = await readFile(join(ROOT, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/search") {
    const state = (url.searchParams.get("state") || "").trim();
    const location = (url.searchParams.get("location") || "").trim();
    if (!state || !location) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "state and location are required" }));
      return;
    }
    console.log(`→ /api/search state=${state} location=${location}`);
    try {
      const result = await runEmptySessions(state, location);
      const movies = (result.movies || []).map((m) => ({
        title: m.title,
        sessions: (m.sessions || []).map((s) => ({
          time: s.time,
          bookingUrl: s.bookingUrl?.startsWith("http")
            ? s.bookingUrl
            : `https://www.hoyts.com.au${s.bookingUrl || ""}`,
          xtremescreen: (s.tags || []).some((t) => /xtremescreen/i.test(t)),
        })),
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ movies }));
    } catch (err) {
      console.error("scraper error:", err.message);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
