import type {
  DiscoveredResearchPage,
  LocationDiscovery,
  ResearchDiscoveryFile,
  ResearchFile,
  ResolutionFile,
  WikipediaPageLink,
} from "./model.js";
import { CachedHttpClient } from "./api.js";
import type { RgoGoodsCatalog } from "./crops.js";
import { parseLocationInput } from "./inventory.js";
import {
  discoverGrokipediaPage,
  researchGrokipediaPage,
} from "./grokipedia.js";
import {
  discoverWikipediaPages,
  fetchWikipediaPageContents,
  researchWikipediaPage,
  wikipediaTargetKey,
  type WikipediaResearchTarget,
} from "./wikipedia.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isHttpsUrlForHost(value: string, hostname: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === hostname;
  } catch {
    return false;
  }
}

export function parseResearchDiscoveryFile(
  value: unknown,
): ResearchDiscoveryFile {
  if (
    !isRecord(value) ||
    value.formatVersion !== 1 ||
    typeof value.generatedAt !== "string" ||
    typeof value.resolutionFile !== "string" ||
    !Array.isArray(value.locations)
  ) {
    throw new Error("Invalid research page discovery file");
  }

  const locations: LocationDiscovery[] = value.locations.map(
    (entry, index) => {
      if (
        !isRecord(entry) ||
        typeof entry.qid !== "string" ||
        typeof entry.placeLabel !== "string" ||
        !Array.isArray(entry.pages) ||
        !Array.isArray(entry.notes) ||
        !entry.notes.every((note) => typeof note === "string")
      ) {
        throw new Error(`Invalid discovery record at locations[${index}]`);
      }
      const location = parseLocationInput([entry.location])[0];
      if (!location) {
        throw new Error(`Missing location at locations[${index}]`);
      }
      const pages: DiscoveredResearchPage[] = entry.pages.map(
        (page, pageIndex) => {
          if (
            !isRecord(page) ||
            !isRecord(page.source) ||
            typeof page.source.provider !== "string" ||
            typeof page.source.language !== "string" ||
            typeof page.source.title !== "string" ||
            typeof page.source.url !== "string" ||
            typeof page.retrievalMode !== "string"
          ) {
            throw new Error(
              `Invalid discovered page at locations[${index}].pages[${pageIndex}]`,
            );
          }
          const provider = page.source.provider;
          const retrievalMode = page.retrievalMode;
          const language = page.source.language;
          const title = page.source.title;
          const url = page.source.url;
          if (
            !["wikipedia", "grokipedia"].includes(provider) ||
            !/^[a-z][a-z0-9-]*$/i.test(language) ||
            ![
              "local-wikipedia",
              "english-wikipedia-fallback",
              "grokipedia",
            ].includes(retrievalMode)
          ) {
            throw new Error(
              `Invalid source metadata at locations[${index}].pages[${pageIndex}]`,
            );
          }
          if (
            (provider === "wikipedia" &&
              (retrievalMode === "grokipedia" ||
                !isHttpsUrlForHost(url, `${language}.wikipedia.org`))) ||
            (provider === "grokipedia" &&
              (retrievalMode !== "grokipedia" ||
                !isHttpsUrlForHost(url, "grokipedia.com")))
          ) {
            throw new Error(
              `Invalid source URL at locations[${index}].pages[${pageIndex}]`,
            );
          }
          const fetchUrl = page.fetchUrl;
          if (
            fetchUrl !== undefined &&
            (typeof fetchUrl !== "string" ||
              !isHttpsUrlForHost(fetchUrl, "grokipedia.com"))
          ) {
            throw new Error(
              `Invalid fetch URL at locations[${index}].pages[${pageIndex}]`,
            );
          }
          return {
            source: {
              provider: provider as "wikipedia" | "grokipedia",
              language,
              title,
              url,
            },
            retrievalMode: retrievalMode as DiscoveredResearchPage["retrievalMode"],
            ...(typeof fetchUrl === "string" ? { fetchUrl } : {}),
          };
        },
      );
      return {
        location,
        qid: entry.qid,
        placeLabel: entry.placeLabel,
        ...(typeof entry.englishWikipediaTitle === "string"
          ? { englishWikipediaTitle: entry.englishWikipediaTitle }
          : {}),
        ...(typeof entry.country === "string"
          ? { country: entry.country }
          : {}),
        ...(typeof entry.administrativeArea === "string"
          ? { administrativeArea: entry.administrativeArea }
          : {}),
        pages,
        notes: entry.notes,
      };
    },
  );
  return {
    formatVersion: 1,
    generatedAt: value.generatedAt,
    resolutionFile: value.resolutionFile,
    locations,
  };
}

function selectedCandidate(
  resolution: ResolutionFile["locations"][number],
): ResolutionFile["locations"][number]["candidates"][number] {
  const qid = resolution.selectedQid;
  if (!qid) {
    throw new Error(
      `Location ${resolution.location.id} has no selectedQid; confirm a place candidate before discovery`,
    );
  }
  const candidate = resolution.candidates.find((item) => item.qid === qid);
  if (!candidate) {
    throw new Error(
      `Selected QID ${qid} for location ${resolution.location.id} is not in its candidate list`,
    );
  }
  return candidate;
}

function wikipediaTargets(
  locationId: string,
  localPages: WikipediaPageLink[],
  englishPage: WikipediaPageLink | undefined,
): WikipediaResearchTarget[] {
  if (localPages.length > 0) {
    return localPages.map((source) => ({
      locationId,
      source,
      retrievalMode: "local-wikipedia",
    }));
  }
  return englishPage
    ? [
        {
          locationId,
          source: englishPage,
          retrievalMode: "english-wikipedia-fallback",
        },
      ]
    : [];
}

export async function discoverResearchPages(
  resolutionFile: ResolutionFile,
  client: CachedHttpClient,
  resolutionFilePath: string,
): Promise<ResearchDiscoveryFile> {
  const selected = resolutionFile.locations.filter(
    (resolution) => resolution.selectedQid !== null,
  );
  const locations: LocationDiscovery[] = [];
  const targetsByLocation = new Map<string, WikipediaResearchTarget[]>();

  for (const resolution of selected) {
    const candidate = selectedCandidate(resolution);
    const targets = wikipediaTargets(
      resolution.location.id,
      candidate.localWikipedia,
      candidate.englishWikipedia,
    );
    targetsByLocation.set(resolution.location.id, targets);
    locations.push({
      location: resolution.location,
      qid: candidate.qid,
      placeLabel: candidate.label,
      ...(candidate.englishWikipedia
        ? { englishWikipediaTitle: candidate.englishWikipedia.title }
        : {}),
      ...(candidate.country ? { country: candidate.country } : {}),
      ...(candidate.administrativeArea
        ? { administrativeArea: candidate.administrativeArea }
        : {}),
      pages: [],
      notes:
        targets.length === 0
          ? ["No local-language or English Wikipedia page is linked from Wikidata."]
          : [],
    });
  }

  const allTargets = [...targetsByLocation.values()].flat();
  const availableWikipediaPages = await discoverWikipediaPages(
    allTargets,
    client,
  );
  let wikipediaPageCount = 0;
  for (const location of locations) {
    for (const target of targetsByLocation.get(location.location.id) ?? []) {
      if (!availableWikipediaPages.has(wikipediaTargetKey(target))) {
        location.notes.push(
          `The linked ${target.source.language} Wikipedia page no longer exists: ${target.source.title}.`,
        );
        continue;
      }
      location.pages.push({
        source: { ...target.source, provider: "wikipedia" },
        retrievalMode: target.retrievalMode,
      });
      wikipediaPageCount += 1;
    }
  }

  let grokipediaPageCount = 0;
  for (const location of locations) {
    const title = location.englishWikipediaTitle ?? location.placeLabel;
    const page = await discoverGrokipediaPage(title, client);
    if (page) {
      location.pages.push(page);
      grokipediaPageCount += 1;
    } else {
      location.notes.push(
        `No exact-title Grokipedia article was found for "${title}".`,
      );
    }
    if (location.pages.length === 0) {
      location.notes.push("No article pages were found on either source.");
    }
  }

  const locationsWithPages = locations.filter(
    (location) => location.pages.length > 0,
  ).length;
  console.log(
    `Discovered ${wikipediaPageCount} Wikipedia and ${grokipediaPageCount} Grokipedia pages across ${locationsWithPages}/${locations.length} locations.`,
  );
  return {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    resolutionFile: resolutionFilePath,
    locations,
  };
}

function wikipediaTarget(
  locationId: string,
  page: DiscoveredResearchPage,
): WikipediaResearchTarget {
  if (
    page.source.provider !== "wikipedia" ||
    page.retrievalMode === "grokipedia"
  ) {
    throw new Error("Invalid Wikipedia page in research discovery data");
  }
  return {
    locationId,
    source: {
      language: page.source.language,
      title: page.source.title,
      url: page.source.url,
    },
    retrievalMode: page.retrievalMode,
  };
}

export async function researchDiscoveredPages(
  discoveryFile: ResearchDiscoveryFile,
  client: CachedHttpClient,
  catalog: RgoGoodsCatalog,
): Promise<ResearchFile> {
  const wikipediaPages = discoveryFile.locations.flatMap((location) =>
    location.pages
      .filter((page) => page.source.provider === "wikipedia")
      .map((page) => wikipediaTarget(location.location.id, page)),
  );
  const wikipediaContents = await fetchWikipediaPageContents(
    wikipediaPages,
    client,
  );
  const locations: ResearchFile["locations"] = [];

  for (const location of discoveryFile.locations) {
    const sources = [];
    const notes = [...location.notes];
    for (const page of location.pages) {
      if (page.source.provider === "wikipedia") {
        const target = wikipediaTarget(location.location.id, page);
        const content = wikipediaContents.get(wikipediaTargetKey(target));
        if (!content) {
          notes.push(
            `The ${page.source.language} Wikipedia page disappeared after discovery: ${page.source.title}.`,
          );
          continue;
        }
        sources.push(researchWikipediaPage(content, catalog));
      } else {
        sources.push(
          await researchGrokipediaPage(page, client, catalog),
        );
      }
    }
    locations.push({
      location: location.location,
      qid: location.qid,
      placeLabel: location.placeLabel,
      ...(location.englishWikipediaTitle
        ? { englishWikipediaTitle: location.englishWikipediaTitle }
        : {}),
      ...(location.country ? { country: location.country } : {}),
      ...(location.administrativeArea
        ? { administrativeArea: location.administrativeArea }
        : {}),
      sources,
      notes,
    });
  }

  return {
    formatVersion: 3,
    generatedAt: new Date().toISOString(),
    resolutionFile: discoveryFile.resolutionFile,
    locations,
  };
}
