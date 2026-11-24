import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CachedHttpClient } from "../scripts/rgo-research/api.js";
import {
  loadRgoGoodsCatalog,
  matchRgoGoods,
} from "../scripts/rgo-research/crops.js";
import { addGrokipediaEvidence } from "../scripts/rgo-research/grokipedia.js";
import {
  parseTuberReviewLocations,
  parseLocationInput,
  parseResolutionReviewCsv,
  parseResolutionFile,
} from "../scripts/rgo-research/inventory.js";
import { encodeCsvRow, parseCsv } from "../scripts/rgo-research/csv.js";
import type {
  ResearchFile,
  ResolutionFile,
} from "../scripts/rgo-research/model.js";
import {
  discoverResearchPages,
  researchDiscoveredPages,
} from "../scripts/rgo-research/research.js";
import { resolveLocations } from "../scripts/rgo-research/wikidata.js";
import {
  addEu5Provinces,
  parseEu5ProvinceMap,
} from "../scripts/rgo-research/provinces.js";
import {
  discoverWikipediaPages,
  fetchWikipediaPageContents,
  wikipediaTargetKey,
  type WikipediaResearchTarget,
} from "../scripts/rgo-research/wikipedia.js";
import {
  writeResearchDiscoveryReport,
  writeResearchReports,
  writeResolutionReports,
} from "../scripts/rgo-research/report.js";
import {
  getAdminScaleRecord,
  parseAdminScaleIndex,
} from "../scripts/rgo-research/admin-scale.js";
import type { AdminScaleIndex } from "../scripts/rgo-research/admin-scale.js";

const rootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function createTemporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "rgo-research-test-"));
}

async function createResearchCatalog(
  temporaryDirectory: string,
): Promise<Awaited<ReturnType<typeof loadRgoGoodsCatalog>>> {
  const vanillaGoodsDirectory = path.join(temporaryDirectory, "vanilla-goods");
  const justGoodsDirectory = path.join(temporaryDirectory, "just-goods");
  await Promise.all([
    mkdir(vanillaGoodsDirectory, { recursive: true }),
    mkdir(justGoodsDirectory, { recursive: true }),
  ]);
  const rawMaterial = (id: string, food?: number) =>
    `${id} = {\n category = raw_material\n${food === undefined ? "" : ` food = ${food}\n`}}\n`;
  await writeFile(
    path.join(vanillaGoodsDirectory, "raw-materials.txt"),
    "\uFEFF" +
      [
        rawMaterial("fruit"),
      rawMaterial("vanilla_food", 0.3),
      rawMaterial("cocoa"),
      rawMaterial("chili"),
      ].join(""),
    "utf8",
  );
  await writeFile(
    path.join(justGoodsDirectory, "raw-materials.txt"),
    [
      rawMaterial("just_goods_food", 0.2),
      rawMaterial("palmoil"),
      rawMaterial("bisons"),
    ].join(""),
    "utf8",
  );
  return loadRgoGoodsCatalog(
    path.join(rootDirectory, "config", "rgo-research-crops.json"),
    vanillaGoodsDirectory,
    justGoodsDirectory,
  );
}

test("Just Tubers parser reads the two provisional location candidates", async () => {
  const markdown = await readFile(
    path.join(rootDirectory, "decisions", "tuber-location-review.md"),
    "utf8",
  );
  const locations = parseTuberReviewLocations(markdown);
  assert.deepEqual(
    locations.map((location) => location.id),
    ["biobio", "sachchaa_mukku"],
  );
  assert.ok(locations.every((location) => location.englishName.length > 0));
  assert.ok(locations[0].context.includes("EU5 start date: 1337"));
});

test("JSON location input rejects duplicate IDs and missing context", () => {
  assert.throws(
    () =>
      parseLocationInput([
        { id: "one", englishName: "One", context: "" },
        { id: "one", englishName: "Two", context: "" },
      ]),
    /duplicate IDs/,
  );
  assert.throws(
    () => parseLocationInput([{ id: "one", englishName: "One" }]),
    /string id, englishName, and context/,
  );
});

test("EU5 province parser maps locations to their game province", () => {
  const provinces = parseEu5ProvinceMap(`
    crescent = {
      iraq_arabi = {
        basra = {
          not_eligible_for_dynamic_country_name = yes
          basra abadan abdas
        }
        baghdad = { baghdad baqubah }
      }
      limousin = {
        limousin = { limoges }
        la_marche = { gueret }
      }
    }
    iberia_region = {
      toledo_area = {
        west_mancha_province = { ciudad_real calatrava }
      }
    }
  `);
  assert.deepEqual(provinces.get("abdas"), {
    id: "basra",
    name: "Basra",
    areaId: "iraq_arabi",
    areaName: "Iraq Arabi",
    regionId: "crescent",
    regionName: "Crescent",
  });
  assert.deepEqual(provinces.get("gueret"), {
    id: "la_marche",
    name: "La Marche",
    areaId: "limousin",
    areaName: "Limousin",
    regionId: "crescent",
    regionName: "Crescent",
  });
  assert.deepEqual(provinces.get("calatrava"), {
    id: "west_mancha_province",
    name: "West Mancha",
    areaId: "toledo_area",
    areaName: "Toledo",
    regionId: "iberia_region",
    regionName: "Iberia",
  });
  assert.deepEqual(
    addEu5Provinces(
      [{ id: "abdas", englishName: "Abdas", context: "Hüleguids" }],
      provinces,
    ),
    [
      {
        id: "abdas",
        englishName: "Abdas",
        context: "Hüleguids",
        eu5Province: "Basra",
        eu5ProvinceId: "basra",
        eu5Area: "Iraq Arabi",
        eu5AreaId: "iraq_arabi",
        eu5Region: "Crescent",
        eu5RegionId: "crescent",
      },
    ],
  );
});

test("administrative scale index validates records and looks up ISO3 codes", () => {
  const index = parseAdminScaleIndex({
    formatVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    referenceAreaKm2: 100,
    referenceDescription: "EU LAU median",
    countries: {
      FRA: {
        countryIso3: "FRA",
        countryName: "France",
        selectedLevel: "LAU",
        levelName: "LAU (local administrative unit)",
        typicalAreaKm2: 200,
        areaStatistic: "median",
        unitCount: 34_000,
        sourceDataset: "Eurostat GISCO LAU 2024",
        sourceVersion: "2024",
        sourceUrl: "https://example.test/lau",
      },
    },
  });
  assert.equal(getAdminScaleRecord(index, "fra")?.selectedLevel, "LAU");
  assert.equal(getAdminScaleRecord(index, undefined), undefined);
  assert.throws(
    () => parseAdminScaleIndex({ ...index, formatVersion: 2 }),
    /invalid administrative scale index/i,
  );
});

test("generated administrative scale index includes global and GISCO entries", async () => {
  const index = parseAdminScaleIndex(
    JSON.parse(
      await readFile(
        path.join(rootDirectory, "config", "rgo-research-admin-scales.json"),
        "utf8",
      ),
    ),
  );
  assert.ok(Object.keys(index.countries).length >= 200);
  assert.equal(index.countries.FRA?.selectedLevel, "LAU");
  assert.equal(index.countries.USA?.selectedLevel, "ADM2");
  assert.equal(index.countries.IRQ?.areaStatistic, "mean");
});

test("catalog validates configured goods and matches localized crop aliases", async () => {
  const temporaryDirectory = await createTemporaryDirectory();
  try {
    const catalog = await createResearchCatalog(temporaryDirectory);
    assert.equal(catalog.has("fruit"), false);
    assert.equal(catalog.has("cassava"), true);
    assert.equal(catalog.get("vanilla_food")?.sources.has("vanilla"), true);
    assert.equal(
      catalog.get("just_goods_food")?.sources.has("just-goods"),
      true,
    );

    const matches = matchRgoGoods(
      "Manioc vanilla_food just_goods_food cocoa fruit",
      "fr",
      catalog,
    );
    assert.deepEqual(
      matches.slice(0, 3).map((match) => [match.goodId, match.preferenceRank]),
      [
        ["cassava", 1],
        ["just_goods_food", 2],
        ["vanilla_food", 2],
      ],
    );
    assert.equal(matches[0].source, "just-tubers");
    assert.equal(matches[2].foodOutput, 0.3);
    assert.ok(
      matches.some(
        (match) => match.goodId === "cocoa" && match.preferenceRank === 3,
      ),
    );
    assert.equal(matches.some((match) => match.goodId === "fruit"), false);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("cached HTTP client caches Grokipedia text pages and 404 responses", async () => {
  const temporaryDirectory = await createTemporaryDirectory();
  try {
    const requests: string[] = [];
    const client = new CachedHttpClient({
      cachePath: path.join(temporaryDirectory, "cache.json"),
      minIntervalMs: 0,
      fetchImplementation: async (input) => {
        const url = String(input);
        requests.push(url);
        return url.endsWith("/missing")
          ? new Response("", { status: 404 })
          : new Response("<html>cached</html>");
      },
    });

    assert.equal(
      await client.getText("https://grokipedia.com/page/Example"),
      "<html>cached</html>",
    );
    assert.equal(
      await client.getText("https://grokipedia.com/page/Example"),
      "<html>cached</html>",
    );
    assert.equal(
      await client.getText("https://grokipedia.com/missing"),
      null,
    );
    assert.equal(await client.getText("https://grokipedia.com/missing"), null);
    await client.flush();

    assert.equal(requests.length, 2);
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(temporaryDirectory, "cache.json"), "utf8"),
      ).entries,
      {
        "https://grokipedia.com/page/Example": "<html>cached</html>",
        "https://grokipedia.com/missing": null,
      },
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("Wikimedia requests are capped at three concurrent requests", async () => {
  const temporaryDirectory = await createTemporaryDirectory();
  try {
    let activeRequests = 0;
    let peakRequests = 0;
    const userAgents: string[] = [];
    const client = new CachedHttpClient({
      cachePath: path.join(temporaryDirectory, "cache.json"),
      minIntervalMs: 0,
      wikimediaMinIntervalMs: 0,
      fetchImplementation: async (_input, init) => {
        activeRequests += 1;
        peakRequests = Math.max(peakRequests, activeRequests);
        userAgents.push(new Headers(init?.headers).get("User-Agent") ?? "");
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeRequests -= 1;
        return Response.json({ ok: true });
      },
    });

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        client.get(
          `https://www.wikidata.org/w/api.php?action=query&titles=Place${index}`,
        ),
      ),
    );

    assert.equal(peakRequests, 3);
    assert.ok(
      userAgents.every((userAgent) =>
        userAgent.includes("JustTubersRgoResearch/0.1"),
      ),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("Wikimedia request starts are spaced to 200 per minute", async () => {
  const temporaryDirectory = await createTemporaryDirectory();
  try {
    const requestTimes: number[] = [];
    const client = new CachedHttpClient({
      cachePath: path.join(temporaryDirectory, "cache.json"),
      fetchImplementation: async () => {
        requestTimes.push(Date.now());
        return Response.json({ ok: true });
      },
    });

    await Promise.all([
      client.get("https://www.wikidata.org/w/api.php?action=query&titles=one"),
      client.get("https://www.wikidata.org/w/api.php?action=query&titles=two"),
    ]);

    assert.ok(requestTimes[1] - requestTimes[0] >= 250);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("HTTP throttling and Wikimedia maxlag responses are retried", async () => {
  const temporaryDirectory = await createTemporaryDirectory();
  try {
    const requestTimes: number[] = [];
    const maxlagTimes: number[] = [];
    let maxlagAttempts = 0;
    const client = new CachedHttpClient({
      cachePath: path.join(temporaryDirectory, "cache.json"),
      minIntervalMs: 0,
      wikimediaMinIntervalMs: 0,
      fetchImplementation: async (input) => {
        const url = new URL(String(input));
        if (url.searchParams.get("titles") === "throttled") {
          requestTimes.push(Date.now());
          if (requestTimes.length === 1) {
            return new Response("slow down", {
              status: 429,
              headers: { "Retry-After": "0.02" },
            });
          }
          return Response.json({ query: { pages: [] } });
        }

        maxlagAttempts += 1;
        maxlagTimes.push(Date.now());
        if (maxlagAttempts === 1) {
          return Response.json(
            { error: { code: "maxlag", lag: 0 } },
            { headers: { "Retry-After": "0" } },
          );
        }
        return Response.json({ query: { pages: [] } });
      },
    });

    await client.get(
      "https://www.wikidata.org/w/api.php?action=query&titles=throttled",
    );
    await client.get(
      "https://www.wikidata.org/w/api.php?action=query&titles=maxlag",
    );

    assert.ok(requestTimes[1] - requestTimes[0] >= 15);
    assert.equal(maxlagAttempts, 2);
    assert.ok(maxlagTimes[1] - maxlagTimes[0] >= 4_900);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("Wikipedia discovers and retrieves 51 titles in batches of 50", async () => {
  const temporaryDirectory = await createTemporaryDirectory();
  try {
    const requestCounts = new Map<string, number>();
    const client = new CachedHttpClient({
      cachePath: path.join(temporaryDirectory, "cache.json"),
      minIntervalMs: 0,
      fetchImplementation: async (input) => {
        const url = new URL(String(input));
        const prop = url.searchParams.get("prop") ?? "";
        requestCounts.set(prop, (requestCounts.get(prop) ?? 0) + 1);
        const titles = url.searchParams
          .get("titles")
          ?.split("|")
          .map((title) => title.replace(/_/g, " ")) ?? [];
        return Response.json({
          query: {
            pages: titles.map((title, index) =>
              prop === "info"
                ? { pageid: index + 1, title }
                : {
                    pageid: index + 1,
                    title,
                    revisions: [
                      {
                        revid: index + 100,
                        slots: { main: { content: `== History ==\\n${title}` } },
                      },
                    ],
                  },
            ),
          },
        });
      },
    });
    const targets: WikipediaResearchTarget[] = Array.from(
      { length: 51 },
      (_, index) => ({
        locationId: `loc-${index}`,
        source: {
          language: "en",
          title: `Place ${index}`,
          url: `https://en.wikipedia.org/wiki/Place_${index}`,
        },
        retrievalMode: "local-wikipedia",
      }),
    );

    const available = await discoverWikipediaPages(targets, client);
    assert.equal(available.size, 51);
    const contents = await fetchWikipediaPageContents(targets, client);
    assert.equal(contents.size, 51);
    assert.equal(requestCounts.get("info"), 2);
    assert.equal(requestCounts.get("revisions"), 2);
    assert.ok(contents.has(wikipediaTargetKey(targets[50])));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("Grokipedia uses exact public search results and reports article evidence", async () => {
  const temporaryDirectory = await createTemporaryDirectory();
  try {
    const requestedUrls: string[] = [];
    const pageHtml = `<!doctype html>
      <html><head>
        <link rel="canonical" href="https://grokipedia.com/page/Example">
        <script type="application/ld+json">{"dateModified":"2025-03-04"}</script>
      </head><body>
        <h1>Example</h1>
        <div class="article-body">
          <h2>History</h2>
          <p>Taro cultivation was recorded by 1200.
            <a href="https://example.org/history">Reference</a></p>
        </div>
      </body></html>`;
    const client = new CachedHttpClient({
      cachePath: path.join(temporaryDirectory, "cache.json"),
      minIntervalMs: 0,
      fetchImplementation: async (input) => {
        const url = new URL(String(input));
        requestedUrls.push(url.href);
        if (url.pathname === "/page/Example") {
          return new Response(null, { status: 404 });
        }
        if (url.pathname === "/search") {
          return new Response(
            '<a data-search-result-link="true" href="/page/Example_(town)">Example</a>',
          );
        }
        if (url.pathname === "/page/Example_(town)") {
          return new Response(pageHtml);
        }
        throw new Error(`Unexpected request: ${url.href}`);
      },
    });
    const catalog = await createResearchCatalog(temporaryDirectory);
    const research: ResearchFile = {
      formatVersion: 3,
      generatedAt: "2026-01-01T00:00:00.000Z",
      resolutionFile: "test-resolution.json",
      locations: [
        {
          location: { id: "example", englishName: "Example", context: "" },
          qid: "Q1",
          placeLabel: "Example",
          sources: [],
          notes: [],
        },
      ],
    };

    const result = await addGrokipediaEvidence(research, client, catalog);
    const [article] = result.locations[0].sources;
    assert.equal(article.source.provider, "grokipedia");
    assert.equal(article.source.title, "Example");
    assert.equal(article.source.url, "https://grokipedia.com/page/Example");
    assert.equal(article.pageModifiedAt, "2025-03-04");
    assert.equal(article.retrievalMode, "grokipedia");
    assert.ok(article.notes.some((note) => note.includes("AI-generated")));
    assert.deepEqual(article.pageCitationUrls, ["https://example.org/history"]);
    assert.ok(article.sections[0].pre1337Years.includes(1200));
    assert.ok(
      article.sections[0].cropMatches.some(
        (match) => match.goodId === "taro",
      ),
    );
    assert.ok(
      requestedUrls.every((url) => !new URL(url).pathname.startsWith("/api/")),
    );
    assert.equal(requestedUrls.length, 3);
    const reportOutput = await writeResearchReports(
      temporaryDirectory,
      "grok-research.json",
      result,
    );
    const markdown = await readFile(reportOutput.markdownPath, "utf8");
    const reviewCsv = await readFile(reportOutput.rgoReviewCsvPath, "utf8");
    assert.ok(markdown.includes("Grokipedia (AI-generated)"));
    assert.ok(markdown.includes("SpaceXSI Community License Agreement"));
    assert.ok(markdown.includes("https://example.org/history"));
    assert.ok(reviewCsv.includes("https://example.org/history"));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("Grokipedia ignores non-exact search matches", async () => {
  const temporaryDirectory = await createTemporaryDirectory();
  try {
    const requestedUrls: string[] = [];
    const client = new CachedHttpClient({
      cachePath: path.join(temporaryDirectory, "cache.json"),
      minIntervalMs: 0,
      fetchImplementation: async (input) => {
        const url = new URL(String(input));
        requestedUrls.push(url.href);
        if (url.pathname === "/page/Example") {
          return new Response(
            "<h1>Example village</h1><div class='article-body'></div>",
          );
        }
        if (url.pathname === "/search") {
          return new Response(
            '<a data-search-result-link="true" href="/page/Example-village">Example village</a>',
          );
        }
        throw new Error(`Unexpected request: ${url.href}`);
      },
    });
    const catalog = await createResearchCatalog(temporaryDirectory);
    const research: ResearchFile = {
      formatVersion: 3,
      generatedAt: "2026-01-01T00:00:00.000Z",
      resolutionFile: "test-resolution.json",
      locations: [
        {
          location: { id: "example", englishName: "Example", context: "" },
          qid: "Q1",
          placeLabel: "Example",
          sources: [],
          notes: [],
        },
      ],
    };

    const result = await addGrokipediaEvidence(research, client, catalog);
    assert.equal(result.locations[0].sources.length, 0);
    assert.ok(
      result.locations[0].notes.some((note) =>
        note.includes("No exact-title Grokipedia article"),
      ),
    );
    assert.equal(requestedUrls.length, 2);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("Wikidata resolver returns place candidates without selecting one", async () => {
  const temporaryDirectory = await createTemporaryDirectory();
  try {
    const searchQueries: string[] = [];
    const fetchImplementation: typeof fetch = async (input) => {
      const url = new URL(String(input));
      const params = url.searchParams;
      if (params.get("action") === "wbsearchentities") {
        assert.equal(params.get("maxlag"), "10");
        searchQueries.push(params.get("search") ?? "");
        return Response.json({
          search: [
            {
              id: "Q1",
              label: "Blois",
              description: "commune in France",
            },
            {
              id: "Q3",
              label: "Blois",
              description: "family name",
            },
            {
              id: "Q4",
              label: "Blois",
              description: "person",
            },
            {
              id: "Q6",
              label: "Blois-sur-Seille",
              description: "commune in Jura, France",
            },
          ],
        });
      }

      const ids = (params.get("ids") ?? "").split("|");
      const entities: Record<string, unknown> = {};
      if (ids.includes("Q1")) {
        entities.Q1 = {
          id: "Q1",
          labels: { en: { value: "Blois" } },
          descriptions: { en: { value: "commune in France" } },
          claims: {
            P31: [{ mainsnak: { datavalue: { value: { id: "Q515" } } } }],
            P17: [{ mainsnak: { datavalue: { value: { id: "Q142" } } } }],
            P131: [{ mainsnak: { datavalue: { value: { id: "Q2" } } } }],
            P625: [
              {
                mainsnak: {
                  datavalue: {
                    value: { latitude: 47.5861, longitude: 1.3359 },
                  },
                },
              },
            ],
          },
          sitelinks: {
            enwiki: { title: "Blois" },
            frwiki: { title: "Blois" },
          },
        };
      }
      if (ids.includes("Q3")) {
        entities.Q3 = {
          id: "Q3",
          labels: { en: { value: "Blois" } },
          descriptions: { en: { value: "family name" } },
          claims: {
            P31: [{ mainsnak: { datavalue: { value: { id: "Q900" } } } }],
          },
        };
      }
      if (ids.includes("Q4")) {
        entities.Q4 = {
          id: "Q4",
          labels: { en: { value: "Blois" } },
          descriptions: { en: { value: "person" } },
          claims: {
            P31: [{ mainsnak: { datavalue: { value: { id: "Q5" } } } }],
          },
        };
      }
      if (ids.includes("Q6")) {
        entities.Q6 = {
          id: "Q6",
          labels: { en: { value: "Blois-sur-Seille" } },
          descriptions: { en: { value: "commune in Jura, Taiwan" } },
          claims: {
            P31: [{ mainsnak: { datavalue: { value: { id: "Q484170" } } } }],
            P131: [{ mainsnak: { datavalue: { value: { id: "Q7" } } } }],
            P17: [{ mainsnak: { datavalue: { value: { id: "Q8" } } } }],
          },
        };
      }
      if (ids.includes("Q7")) {
        entities.Q7 = {
          id: "Q7",
          labels: { en: { value: "Jura" } },
          claims: {
            P17: [{ mainsnak: { datavalue: { value: { id: "Q8" } } } }],
          },
        };
      }
      if (ids.includes("Q8")) {
        entities.Q8 = {
          id: "Q8",
          labels: { en: { value: "Taiwan" } },
          claims: {
            P37: [{ mainsnak: { datavalue: { value: { id: "Q150" } } } }],
          },
        };
      }
      if (ids.includes("Q484170")) {
        entities.Q484170 = {
          id: "Q484170",
          labels: { en: { value: "commune" } },
        };
      }
      if (ids.includes("Q515")) {
        entities.Q515 = {
          id: "Q515",
          labels: { en: { value: "city" } },
          claims: {
            P279: [{ mainsnak: { datavalue: { value: { id: "Q486972" } } } }],
          },
        };
      }
      if (ids.includes("Q486972")) {
        entities.Q486972 = {
          id: "Q486972",
          labels: { en: { value: "human settlement" } },
          claims: {
            P279: [{ mainsnak: { datavalue: { value: { id: "Q618123" } } } }],
          },
        };
      }
      if (ids.includes("Q618123")) {
        entities.Q618123 = {
          id: "Q618123",
          labels: { en: { value: "geographical object" } },
        };
      }
      if (ids.includes("Q101352")) {
        entities.Q101352 = {
          id: "Q101352",
          labels: { en: { value: "family name" } },
        };
      }
      if (ids.includes("Q900")) {
        entities.Q900 = {
          id: "Q900",
          labels: {
            en: { value: "toponymic family name with geographic ancestry" },
          },
          claims: {
            P279: [
              { mainsnak: { datavalue: { value: { id: "Q17143070" } } } },
              { mainsnak: { datavalue: { value: { id: "Q82794" } } } },
            ],
          },
        };
      }
      if (ids.includes("Q17143070")) {
        entities.Q17143070 = {
          id: "Q17143070",
          labels: { en: { value: "toponymic surname" } },
          claims: {
            P279: [{ mainsnak: { datavalue: { value: { id: "Q82794" } } } }],
          },
        };
      }
      if (ids.includes("Q82794")) {
        entities.Q82794 = {
          id: "Q82794",
          labels: { en: { value: "geographic region" } },
        };
      }
      if (ids.includes("Q5")) {
        entities.Q5 = {
          id: "Q5",
          labels: { en: { value: "human" } },
        };
      }
      if (ids.includes("Q142")) {
        entities.Q142 = {
          id: "Q142",
          labels: { en: { value: "France" } },
          claims: {
            P298: [{ mainsnak: { datavalue: { value: "FRA" } } }],
            P37: [{ mainsnak: { datavalue: { value: { id: "Q150" } } } }],
          },
        };
      }
      if (ids.includes("Q2")) {
        entities.Q2 = {
          id: "Q2",
          labels: { en: { value: "Loir-et-Cher" } },
          descriptions: { en: { value: "department in France" } },
          claims: {
            P31: [{ mainsnak: { datavalue: { value: { id: "Q56061" } } } }],
            P17: [{ mainsnak: { datavalue: { value: { id: "Q142" } } } }],
          },
          sitelinks: {
            enwiki: { title: "Loir-et-Cher" },
            frwiki: { title: "Loir-et-Cher" },
          },
        };
      }
      if (ids.includes("Q56061")) {
        entities.Q56061 = {
          id: "Q56061",
          labels: { en: { value: "administrative territorial entity" } },
        };
      }
      if (ids.includes("Q150")) {
        entities.Q150 = {
          id: "Q150",
          labels: { en: { value: "French" } },
          claims: {
            P424: [{ mainsnak: { datavalue: { value: "fr" } } }],
          },
        };
      }
      return Response.json({ entities });
    };
    const client = new CachedHttpClient({
      cachePath: path.join(temporaryDirectory, "cache.json"),
      minIntervalMs: 0,
      fetchImplementation,
    });

    const adminScaleIndex: AdminScaleIndex = {
      formatVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      referenceAreaKm2: 100,
      referenceDescription: "EU LAU median",
      countries: {
        FRA: {
          countryIso3: "FRA",
          countryName: "France",
          selectedLevel: "LAU",
          levelName: "LAU (local administrative unit)",
          typicalAreaKm2: 200,
          areaStatistic: "median",
          unitCount: 34_000,
          sourceDataset: "Eurostat GISCO LAU 2024",
          sourceVersion: "2024",
          sourceUrl: "https://example.test/lau",
        },
      },
    };
    const result = await resolveLocations(
      [
        {
          id: "blois",
          englishName: "Blois",
          context: "Kingdom of France",
          eu5Province: "Blois",
          eu5Area: "Orleanais",
          eu5Region: "Western Europe",
        },
      ],
      client,
      "test",
      adminScaleIndex,
    );
    const location = result.locations[0];
    assert.equal(location.selectedQid, null);
    assert.equal(location.status, "needs-review");
    assert.equal(location.candidates[0].qid, "Q2");
    assert.equal(location.candidates[0].label, "Loir-et-Cher");
    assert.equal(location.candidates[0].confidence, "medium");
    assert.equal(location.candidates[0].country, "France");
    assert.ok(searchQueries.includes("Blois"));
    assert.ok(searchQueries.includes("Orleanais"));
    assert.ok(searchQueries.includes("Western Europe"));
    assert.equal(location.candidates[0].countryIso3, "FRA");
    assert.equal(location.candidates[0].administrativeScale?.level, "LAU");
    assert.equal(location.candidates.length, 1);
    assert.equal(
      location.candidates.some((candidate) => candidate.qid === "Q1"),
      false,
    );
    assert.equal(
      location.candidates.some((candidate) => candidate.qid === "Q3"),
      false,
    );
    assert.equal(
      location.candidates.some((candidate) => candidate.qid === "Q4"),
      false,
    );
    assert.equal(
      location.candidates.some((candidate) => candidate.qid === "Q6"),
      false,
    );
    assert.deepEqual(
      location.candidates[0].localWikipedia.map((page) => page.language),
      ["fr"],
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("EU5 area and region searches prefer a matching country", async () => {
  const temporaryDirectory = await createTemporaryDirectory();
  try {
    const fetchImplementation: typeof fetch = async (input) => {
      const params = new URL(String(input)).searchParams;
      if (params.get("action") === "wbsearchentities") {
        const search = params.get("search");
        const results =
          search === "Calatrava"
            ? [
                {
                  id: "QPH",
                  label: "Calatrava",
                  description: "municipality in the Philippines",
                },
                {
                  id: "QES",
                  label: "Calatrava",
                  description: "municipality in Spain",
                },
              ]
            : search === "Toledo"
              ? [
                  {
                    id: "QTOLEDO",
                    label: "Toledo",
                    description: "province in Spain",
                  },
                ]
              : [
                  {
                    id: "QIBERIA",
                    label: "Iberia",
                    description: "geographic region in Spain",
                  },
                ];
        return Response.json({ search: results });
      }

      const ids = (params.get("ids") ?? "").split("|");
      const entityData: Record<
        string,
        { label: string; type?: string; country?: string }
      > = {
        QPH: { label: "Calatrava", type: "Q56061", country: "Q928" },
        QES: { label: "Calatrava", type: "Q56061", country: "Q29" },
        QTOLEDO: { label: "Toledo", type: "Q56061", country: "Q29" },
        QIBERIA: { label: "Iberia", type: "Q82794", country: "Q29" },
        Q928: { label: "Philippines" },
        Q29: { label: "Spain" },
        Q56061: { label: "administrative territorial entity" },
        Q82794: { label: "geographic region" },
      };
      const entities = Object.fromEntries(
        ids.flatMap((id) => {
          const data = entityData[id];
          return data
            ? [
                [
                  id,
                  {
                    id,
                    labels: { en: { value: data.label } },
                    descriptions: {
                      en: {
                        value:
                          data.label === "Calatrava"
                            ? id === "QPH"
                              ? "municipality in the Philippines"
                              : "municipality in Spain"
                            : "",
                      },
                    },
                    claims: {
                      ...(data.type
                        ? {
                            P31: [
                              {
                                mainsnak: {
                                  datavalue: { value: { id: data.type } },
                                },
                              },
                            ],
                          }
                        : {}),
                      ...(data.country
                        ? {
                            P17: [
                              {
                                mainsnak: {
                                  datavalue: { value: { id: data.country } },
                                },
                              },
                            ],
                          }
                        : {}),
                    },
                  },
                ],
              ]
            : [];
        }),
      );
      return Response.json({ entities });
    };
    const client = new CachedHttpClient({
      cachePath: path.join(temporaryDirectory, "cache.json"),
      minIntervalMs: 0,
      fetchImplementation,
    });
    const result = await resolveLocations(
      [
        {
          id: "calatrava",
          englishName: "Calatrava",
          context: "Castile",
          eu5Province: "West Mancha",
          eu5Area: "Toledo",
          eu5Region: "Iberia",
        },
      ],
      client,
      "test",
      {
        formatVersion: 1,
        generatedAt: "2026-01-01T00:00:00.000Z",
        referenceAreaKm2: 100,
        referenceDescription: "EU LAU median",
        countries: {},
      },
    );
    assert.deepEqual(
      result.locations[0].candidates.map((candidate) => candidate.country),
      ["Spain"],
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("resolution JSON parser preserves manual place selection", () => {
  const file: ResolutionFile = {
    formatVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    inputSource: "test",
    locations: [
      {
        location: {
          id: "blois",
          englishName: "Blois",
          context: "France",
          eu5Region: "Western Europe",
          eu5RegionId: "western_europe_region",
          eu5Area: "Orleanais",
          eu5AreaId: "orleanais_area",
          eu5Province: "Basra",
          eu5ProvinceId: "basra_province",
        },
        status: "needs-review",
        selectedQid: "Q1",
        candidates: [
          {
            qid: "Q1",
            label: "Blois",
            description: "commune in France",
            score: 125,
            confidence: "high",
            country: "France",
            countryIso3: "FRA",
            administrativeScale: {
              level: "LAU",
              levelName: "LAU (local administrative unit)",
              typicalAreaKm2: 11,
              areaStatistic: "median",
              unitCount: 34_000,
              sourceDataset: "Eurostat GISCO LAU 2024",
              sourceVersion: "2024",
              sourceUrl: "https://example.test/lau",
            },
            localWikipedia: [
              {
                language: "fr",
                title: "Blois",
                url: "https://fr.wikipedia.org/wiki/Blois",
              },
            ],
          },
        ],
      },
    ],
  };
  const parsed = parseResolutionFile(file);
  assert.deepEqual(parsed, file);
  assert.equal(
    parsed.locations[0].candidates[0].administrativeScale?.level,
    "LAU",
  );
  assert.throws(
    () => parseResolutionFile({ ...file, formatVersion: 2 }),
    /invalid format/,
  );
});

test("resolution review CSV applies a single correct-candidate flag", () => {
  const file: ResolutionFile = {
    formatVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    inputSource: "test",
    locations: [
      {
        location: { id: "blois", englishName: "Blois", context: "France" },
        status: "needs-review",
        selectedQid: null,
        candidates: [
          {
            qid: "Q1",
            label: "Blois",
            description: "commune in France",
            score: 125,
            confidence: "high",
            localWikipedia: [],
          },
          {
            qid: "Q2",
            label: "Blois (other)",
            description: "other place",
            score: 60,
            confidence: "low",
            localWikipedia: [],
          },
        ],
      },
    ],
  };
  const csv = [
    encodeCsvRow(["location_id", "candidate_qid", "correct", "label"]),
    encodeCsvRow(["blois", "Q1", "TRUE", "Blois, France"]),
    encodeCsvRow(["blois", "Q2", "FALSE", 'A "different" place']),
  ].join("\r\n");
  assert.deepEqual(parseCsv(csv), [
    ["location_id", "candidate_qid", "correct", "label"],
    ["blois", "Q1", "TRUE", "Blois, France"],
    ["blois", "Q2", "FALSE", 'A "different" place'],
  ]);
  assert.equal(
    parseResolutionReviewCsv(csv, file).locations[0].selectedQid,
    "Q1",
  );
  assert.throws(
    () =>
      parseResolutionReviewCsv(
        [
          "location_id,candidate_qid,correct",
          "blois,Q1,TRUE",
          "blois,Q2,TRUE",
        ].join("\n"),
        file,
      ),
    /more than one candidate correct/,
  );
});

test("resolution reports surface the selected country scale target", async () => {
  const temporaryDirectory = await createTemporaryDirectory();
  try {
    const resolution: ResolutionFile = {
      formatVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      inputSource: "test",
      locations: [
        {
          location: { id: "blois", englishName: "Blois", context: "France" },
          status: "needs-review",
          selectedQid: null,
          candidates: [
            {
              qid: "Q1",
              label: "Blois",
              description: "commune in France",
              score: 100,
              confidence: "high",
              country: "France",
              countryIso3: "FRA",
              administrativeScale: {
                level: "LAU",
                levelName: "LAU (local administrative unit)",
                typicalAreaKm2: 11,
                areaStatistic: "median",
                unitCount: 34_000,
                sourceDataset: "Eurostat GISCO LAU 2024",
                sourceVersion: "2024",
                sourceUrl: "https://example.test/lau",
              },
              localWikipedia: [],
            },
          ],
        },
      ],
    };
    const output = await writeResolutionReports(
      temporaryDirectory,
      "pilot-resolution.json",
      resolution,
    );
    const reviewRows = parseCsv(await readFile(output.reviewCsvPath, "utf8"));
    const levelIndex = reviewRows[0].indexOf("selected_admin_level");
    const areaIndex = reviewRows[0].indexOf("typical_unit_area_km2");
    assert.equal(reviewRows[1][levelIndex], "LAU");
    assert.equal(reviewRows[1][areaIndex], "11");
    assert.equal(reviewRows[1][reviewRows[0].indexOf("correct")], "FALSE");
    assert.match(
      await readFile(output.markdownPath, "utf8"),
      /LAU \(local administrative unit\); 11\.0 km² \(median, Eurostat GISCO LAU 2024\)/,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("Wikipedia research extracts relevant sections, years, citations, and crop signals", async () => {
  const temporaryDirectory = await createTemporaryDirectory();
  try {
    const wikitext = [
      "'''Blois''' est une commune.",
      "== Histoire ==",
      "Le commerce local est mentionné au XVe siècle, notamment en 1450.",
      "Des cultures sont attestées dans la région avant 1200.",
      "Contexte historique. ".repeat(180),
      "Le manioc était cultivé localement en 1790.",
      "=== Agriculture ===",
      "La culture du manioc est aussi mentionnée.",
      "<ref>{{cite web |url=https://example.org/history |title=History}}</ref>",
      "== Géographie ==",
      "La Loire traverse la ville.",
      "== Économie ==",
      "Le manioc était vendu en 1789.",
    ].join("\n");
    const client = new CachedHttpClient({
      cachePath: path.join(temporaryDirectory, "cache.json"),
      minIntervalMs: 0,
      fetchImplementation: async (input) => {
        const url = new URL(String(input));
        if (url.hostname === "grokipedia.com") {
          return url.pathname.startsWith("/page/")
            ? new Response(null, { status: 404 })
            : new Response("<html></html>");
        }
        if (url.searchParams.get("prop") === "info") {
          return Response.json({
            query: { pages: [{ pageid: 1, title: "Blois" }] },
          });
        }
        if (url.searchParams.get("prop") === "revisions") {
          return Response.json({
            query: {
              pages: [
                {
                  pageid: 1,
                  title: "Blois",
                  revisions: [
                    {
                      revid: 123,
                      slots: { main: { content: wikitext } },
                    },
                  ],
                },
              ],
            },
          });
        }
        throw new Error(`Unexpected request: ${url.href}`);
      },
    });
    const catalog = await createResearchCatalog(temporaryDirectory);
    const resolution: ResolutionFile = {
      formatVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      inputSource: "test",
      locations: [
        {
          location: { id: "blois", englishName: "Blois", context: "France" },
          status: "needs-review",
          selectedQid: "Q1",
          candidates: [
            {
              qid: "Q1",
              label: "Blois",
              description: "commune in France",
              score: 125,
              confidence: "high",
              country: "France",
              localWikipedia: [
                {
                  language: "fr",
                  title: "Blois",
                  url: "https://fr.wikipedia.org/wiki/Blois",
                },
              ],
            },
          ],
        },
      ],
    };

    const discovery = await discoverResearchPages(
      resolution,
      client,
      "test-resolution.json",
    );
    assert.equal(discovery.locations[0].pages.length, 1);
    const discoveryOutput = await writeResearchDiscoveryReport(
      temporaryDirectory,
      "pilot-discovery.json",
      discovery,
    );
    assert.match(
      await readFile(discoveryOutput.markdownPath, "utf8"),
      /page discovery/i,
    );
    const research = await researchDiscoveredPages(
      discovery,
      client,
      catalog,
    );
    assert.equal(research.formatVersion, 3);
    const [article] = research.locations[0].sources;
    assert.equal(article.source.provider, "wikipedia");
    assert.equal(article.retrievalMode, "local-wikipedia");
    assert.equal(article.pageRevisionId, 123);
    assert.deepEqual(
      article.sections.map((section) => section.heading),
      ["Histoire", "Économie"],
    );
    assert.ok(article.sections[0].years.includes(1450));
    assert.ok(article.sections[0].years.includes(1790));
    assert.ok(article.sections[0].pre1337Years.includes(1200));
    assert.equal(article.sections[0].truncated, true);
    assert.ok(
      article.sections[0].cropMatches.some(
        (match) => match.goodId === "cassava",
      ),
    );
    assert.deepEqual(article.sections[0].citationUrls, [
      "https://example.org/history",
    ]);
    const output = await writeResearchReports(
      temporaryDirectory,
      "pilot-research.json",
      research,
    );
    const reviewRows = parseCsv(
      await readFile(output.rgoReviewCsvPath, "utf8"),
    );
    const goodIdIndex = reviewRows[0].indexOf("good_id");
    const validIndex = reviewRows[0].indexOf("valid_rgo");
    assert.ok(
      reviewRows
        .slice(1)
        .some(
          (row) =>
            row[goodIdIndex] === "cassava" &&
            row[validIndex] === "FALSE",
        ),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("English Wikipedia is used as fallback only when no local page is linked", async () => {
  const temporaryDirectory = await createTemporaryDirectory();
  try {
    const client = new CachedHttpClient({
      cachePath: path.join(temporaryDirectory, "cache.json"),
      minIntervalMs: 0,
      fetchImplementation: async (input) => {
        const url = new URL(String(input));
        if (url.hostname === "grokipedia.com") {
          return url.pathname.startsWith("/page/")
            ? new Response(null, { status: 404 })
            : new Response("<html></html>");
        }
        if (url.searchParams.get("prop") === "info") {
          return Response.json({
            query: { pages: [{ pageid: 10, title: "Example" }] },
          });
        }
        if (url.searchParams.get("prop") === "revisions") {
          return Response.json({
            query: {
              pages: [
                {
                  pageid: 10,
                  title: "Example",
                  revisions: [
                    {
                      revid: 456,
                      slots: { main: { content: "'''Example''' location." } },
                    },
                  ],
                },
              ],
            },
          });
        }
        throw new Error(`Unexpected request: ${url.href}`);
      },
    });
    const catalog = await createResearchCatalog(temporaryDirectory);
    const resolution: ResolutionFile = {
      formatVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      inputSource: "test",
      locations: [
        {
          location: { id: "example", englishName: "Example", context: "" },
          status: "needs-review",
          selectedQid: "Q10",
          candidates: [
            {
              qid: "Q10",
              label: "Example",
              description: "town",
              score: 100,
              confidence: "high",
              localWikipedia: [],
              englishWikipedia: {
                language: "en",
                title: "Example",
                url: "https://en.wikipedia.org/wiki/Example",
              },
            },
          ],
        },
      ],
    };

    const discovery = await discoverResearchPages(
      resolution,
      client,
      "test-resolution.json",
    );
    const research = await researchDiscoveredPages(
      discovery,
      client,
      catalog,
    );
    assert.equal(
      research.locations[0].sources[0].retrievalMode,
      "english-wikipedia-fallback",
    );
    const output = await writeResearchReports(
      temporaryDirectory,
      "no-match-research.json",
      research,
    );
    const reviewRows = parseCsv(
      await readFile(output.rgoReviewCsvPath, "utf8"),
    );
    assert.equal(reviewRows.length, 2);
    assert.equal(
      reviewRows[1][reviewRows[0].indexOf("match_status")],
      "no configured keyword match; needs review",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
