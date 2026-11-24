import type {
  ArticleResearch,
  CropMatch,
  ResearchSection,
  WikipediaPageLink,
} from "./model.js";
import { CachedHttpClient } from "./api.js";
import { matchRgoGoods, type RgoGoodsCatalog } from "./crops.js";

const relevantHeadingTerms = [
  /\bhistory\b/i,
  /\bgeschichte\b/i,
  /\bagriculture\b/i,
  /\blandwirtschaft\b/i,
  /\bpertanian\b/i,
  /\beconomy\b/i,
  /\bgospodarka\b/i,
  /\bekonomi\b/i,
  /\beconomic\b/i,
  /\btrade\b/i,
  /\bindustry\b/i,
  /\bproduction\b/i,
  /\bcultivation\b/i,
  /\bviticulture\b/i,
  /\bagrar\w*\b/i,
  /\bwirtschaft\b/i,
  /\bhandel\b/i,
  /\bsejarah\b/i,
  /\bperdagangan\b/i,
  /\bhistoire\b/i,
  /économie/i,
  /\bagriculture\b/i,
  /\bhistoria\b/i,
  /economía/i,
  /\bcomercio\b/i,
  /\bagricultura\b/i,
  /\bhistoria\b/i,
  /\bekonomia\b/i,
  /\brolnictwo\b/i,
  /история/i,
  /экономика/i,
  /сельское хозяйство/i,
  /歴史/,
  /農業/,
  /経済/,
  /历史/,
  /農業/,
  /经济/,
  /경제/,
  /역사/,
  /농업/,
  /역사/,
];

interface ParsedSection {
  heading: string;
  level: number;
  start: number;
  end: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseSections(wikitext: string): ParsedSection[] {
  const headings: Array<Pick<ParsedSection, "heading" | "level" | "start">> =
    [];
  const pattern = /^(={2,6})\s*(.*?)\s*\1\s*$/gm;
  for (const match of wikitext.matchAll(pattern)) {
    if (match.index === undefined) {
      continue;
    }
    headings.push({
      heading: match[2].replace(/<[^>]+>/g, "").trim(),
      level: match[1].length,
      start: match.index + match[0].length,
    });
  }

  return headings.map((heading, index) => {
    const end = headings
      .slice(index + 1)
      .find((next) => next.level <= heading.level)?.start;
    return {
      ...heading,
      end: end ?? wikitext.length,
    };
  });
}

function removeTemplates(text: string): string {
  let result = text;
  let previous: string;
  do {
    previous = result;
    result = result.replace(/\{\{[^{}]*\}\}/g, " ");
  } while (result !== previous);
  return result;
}

function plainText(wikitext: string): string {
  return removeTemplates(wikitext)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<ref\b[^>]*\/\s*>/gi, " ")
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, " ")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?\]\]/g, "$1")
    .replace(/\[(?:https?:\/\/\S+?)(?:\s+([^\]]+))?\]/g, "$1")
    .replace(/'{2,5}/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractCitationUrls(wikitext: string): string[] {
  const urls = new Set<string>();
  const references = [
    ...wikitext.matchAll(/<ref\b[^>]*>([\s\S]*?)<\/ref>/gi),
    ...wikitext.matchAll(/\{\{cite[^{}]*\}\}/gi),
  ];
  for (const reference of references) {
    for (const match of reference[0].matchAll(/https?:\/\/[^\s|}\]<]+/gi)) {
      urls.add(match[0].replace(/&amp;/g, "&").replace(/[.,;]+$/, ""));
    }
  }
  return [...urls];
}

function extractYears(text: string): number[] {
  const years = [...text.matchAll(/\b(1[3-8]\d{2})\b/g)].map((match) =>
    Number(match[1]),
  );
  return [...new Set(years)].sort((left, right) => left - right);
}

function extractPre1337Years(text: string): number[] {
  const years = [...text.matchAll(/\b(\d{3,4})\b/g)]
    .map((match) => Number(match[1]))
    .filter((year) => year >= 1 && year < 1337);
  return [...new Set(years)].sort((left, right) => left - right);
}

export function isRelevantHeading(heading: string): boolean {
  return relevantHeadingTerms.some((term) => term.test(heading));
}

export function sectionResearch(
  heading: string,
  wikitext: string,
  language: string,
  catalog: RgoGoodsCatalog,
  citationUrls?: string[],
): ResearchSection {
  const fullText = plainText(wikitext);
  const text = fullText.slice(0, 2500);
  return {
    heading,
    text,
    truncated: fullText.length > text.length,
    years: extractYears(fullText),
    pre1337Years: extractPre1337Years(fullText),
    cropMatches: matchRgoGoods(fullText, language, catalog),
    citationUrls: citationUrls ?? extractCitationUrls(wikitext),
  };
}

export function aggregateCropMatches(sections: ResearchSection[]) {
  const matches = new Map<string, CropMatch>();
  for (const section of sections) {
    for (const match of section.cropMatches) {
      const current = matches.get(match.goodId);
      if (current) {
        current.occurrenceCount += match.occurrenceCount;
      } else {
        matches.set(match.goodId, { ...match });
      }
    }
  }
  return [...matches.values()].sort(
    (left, right) =>
      left.preferenceRank - right.preferenceRank ||
      left.goodId.localeCompare(right.goodId),
  );
}

function researchArticle(
  source: WikipediaPageLink,
  retrievalMode: "local-wikipedia" | "english-wikipedia-fallback",
  wikitext: string,
  revisionId: number | undefined,
  catalog: RgoGoodsCatalog,
): ArticleResearch {
  const parsedSections = parseSections(wikitext);
  const relevantSections = parsedSections.filter((section) =>
    isRelevantHeading(section.heading),
  );
  let relevant = relevantSections.filter(
    (section) =>
      !relevantSections.some(
        (parent) =>
          parent.level < section.level &&
          parent.start <= section.start &&
          parent.end >= section.end,
      ),
  );
  const notes: string[] = [];

  if (relevant.length === 0) {
    relevant = parsedSections.slice(0, 0);
    notes.push(
      "No history, economy, agriculture, trade, or industry section heading was found; only the article lead is summarized.",
    );
  }

  const sections =
    relevant.length > 0
      ? relevant.map((section) =>
          sectionResearch(
            section.heading,
            wikitext.slice(section.start, section.end),
            source.language,
            catalog,
          ),
        )
      : [
          sectionResearch(
            "Lead",
            wikitext.slice(0, parsedSections[0]?.start ?? wikitext.length),
            source.language,
            catalog,
          ),
        ];
  if (sections.every((section) => section.text.length === 0)) {
    notes.push("No readable prose was extracted from the selected page.");
  }

  return {
    source: { ...source, provider: "wikipedia" },
    retrievalMode,
    ...(revisionId !== undefined ? { pageRevisionId: revisionId } : {}),
    pageCitationUrls: [],
    sections,
    articleRgoMatches: aggregateCropMatches(sections),
    notes,
  };
}

export interface WikipediaResearchTarget {
  locationId: string;
  source: WikipediaPageLink;
  retrievalMode: "local-wikipedia" | "english-wikipedia-fallback";
}

export interface WikipediaPageContent {
  target: WikipediaResearchTarget;
  wikitext: string;
  revisionId?: number;
}

function normalizedPageTitle(title: string): string {
  return title
    .normalize("NFKC")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en");
}

export function wikipediaTargetKey(target: WikipediaResearchTarget): string {
  return `${target.locationId}\u0000${target.source.language}\u0000${normalizedPageTitle(target.source.title)}`;
}

function chunked<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function queryPages(value: unknown): {
  query: Record<string, unknown>;
  pages: Record<string, unknown>[];
} {
  if (
    !isRecord(value) ||
    !isRecord(value.query) ||
    !Array.isArray(value.query.pages) ||
    !value.query.pages.every(isRecord)
  ) {
    throw new Error("Wikipedia returned an unexpected batch page response");
  }
  return { query: value.query, pages: value.query.pages };
}

function titleAliases(query: Record<string, unknown>): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const key of ["normalized", "redirects"]) {
    const mappings = query[key];
    if (!Array.isArray(mappings)) {
      continue;
    }
    for (const mapping of mappings) {
      if (
        isRecord(mapping) &&
        typeof mapping.from === "string" &&
        typeof mapping.to === "string"
      ) {
        aliases.set(normalizedPageTitle(mapping.from), mapping.to);
      }
    }
  }
  return aliases;
}

function resolvePageTitle(title: string, aliases: Map<string, string>): string {
  let current = title;
  const visited = new Set<string>();
  while (aliases.has(normalizedPageTitle(current))) {
    const key = normalizedPageTitle(current);
    if (visited.has(key)) {
      throw new Error(`Wikipedia returned a title redirect cycle for "${title}"`);
    }
    visited.add(key);
    current = aliases.get(key)!;
  }
  return current;
}

function groupLanguageTargets(
  targets: WikipediaResearchTarget[],
): Map<string, WikipediaResearchTarget[]> {
  const grouped = new Map<string, WikipediaResearchTarget[]>();
  for (const target of targets) {
    const languageTargets = grouped.get(target.source.language) ?? [];
    languageTargets.push(target);
    grouped.set(target.source.language, languageTargets);
  }
  return grouped;
}

function wikipediaBatchUrl(
  language: string,
  targets: WikipediaResearchTarget[],
  prop: "info" | "revisions",
): string {
  const parameters = new URLSearchParams({
    action: "query",
    prop,
    titles: targets.map((target) => target.source.title).join("|"),
    redirects: "1",
    format: "json",
    formatversion: "2",
    maxlag: "5",
  });
  if (prop === "revisions") {
    parameters.set("rvprop", "ids|content");
    parameters.set("rvslots", "main");
  }
  return `https://${language}.wikipedia.org/w/api.php?${parameters.toString()}`;
}

async function forEachWikipediaBatch<T>(
  targets: WikipediaResearchTarget[],
  prop: "info" | "revisions",
  client: CachedHttpClient,
  processBatch: (
    batch: WikipediaResearchTarget[],
    response: unknown,
  ) => T[],
): Promise<T[]> {
  const results: T[] = [];
  const byLanguage = groupLanguageTargets(targets);
  for (const [language, languageTargets] of byLanguage) {
    const batches = chunked(languageTargets, 50);
    const batchResults = await Promise.all(
      batches.map(async (batch) => {
        const response = await client.get(
          wikipediaBatchUrl(language, batch, prop),
        );
        return processBatch(batch, response);
      }),
    );
    batchResults.forEach((batch) => results.push(...batch));
  }
  return results;
}

export async function discoverWikipediaPages(
  targets: WikipediaResearchTarget[],
  client: CachedHttpClient,
): Promise<Set<string>> {
  const available = await forEachWikipediaBatch(
    targets,
    "info",
    client,
    (batch, response) => {
      const { query, pages } = queryPages(response);
      const aliases = titleAliases(query);
      const pagesByTitle = new Map(
        pages.map((page) => [
          normalizedPageTitle(String(page.title ?? "")),
          page,
        ]),
      );
      return batch.flatMap((target) => {
        const finalTitle = resolvePageTitle(target.source.title, aliases);
        const page = pagesByTitle.get(normalizedPageTitle(finalTitle));
        return page && !("missing" in page)
          ? [wikipediaTargetKey(target)]
          : [];
      });
    },
  );
  return new Set(available);
}

export async function fetchWikipediaPageContents(
  targets: WikipediaResearchTarget[],
  client: CachedHttpClient,
): Promise<Map<string, WikipediaPageContent>> {
  const contents = await forEachWikipediaBatch(
    targets,
    "revisions",
    client,
    (batch, response) => {
      const { query, pages } = queryPages(response);
      const aliases = titleAliases(query);
      const pagesByTitle = new Map(
        pages.map((page) => [
          normalizedPageTitle(String(page.title ?? "")),
          page,
        ]),
      );
      const results: WikipediaPageContent[] = [];
      for (const target of batch) {
        const finalTitle = resolvePageTitle(target.source.title, aliases);
        const page = pagesByTitle.get(normalizedPageTitle(finalTitle));
        if (!page || "missing" in page) {
          continue;
        }
        const revision = Array.isArray(page.revisions)
          ? page.revisions[0]
          : undefined;
        const slots = isRecord(revision) ? revision.slots : undefined;
        const main = isRecord(slots) ? slots.main : undefined;
        const wikitext =
          isRecord(main) && typeof main.content === "string"
            ? main.content
            : isRecord(main) && typeof main["*"] === "string"
              ? main["*"]
              : undefined;
        if (wikitext === undefined) {
          throw new Error(
            `Wikipedia returned no wikitext for "${target.source.title}"`,
          );
        }
        results.push({
          target,
          wikitext,
          ...(isRecord(revision) && typeof revision.revid === "number"
            ? { revisionId: revision.revid }
            : {}),
        });
      }
      return results;
    },
  );
  return new Map(contents.map((content) => [wikipediaTargetKey(content.target), content]));
}

export function researchWikipediaPage(
  content: WikipediaPageContent,
  catalog: RgoGoodsCatalog,
): ArticleResearch {
  return researchArticle(
    content.target.source,
    content.target.retrievalMode,
    content.wikitext,
    content.revisionId,
    catalog,
  );
}
