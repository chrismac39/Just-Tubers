import type {
  ArticleResearch,
  DiscoveredResearchPage,
  LocationDiscovery,
  ResearchDiscoveryFile,
  ResearchFile,
  ResearchSection,
} from "./model.js";
import { CachedHttpClient } from "./api.js";
import type { RgoGoodsCatalog } from "./crops.js";
import {
  aggregateCropMatches,
  isRelevantHeading,
  sectionResearch,
} from "./wikipedia.js";

const grokipediaOrigin = "https://grokipedia.com";
const grokipediaHost = new URL(grokipediaOrigin).hostname;

interface HtmlElement {
  start: number;
  end: number;
  innerHtml: string;
}

interface GrokipediaPage {
  title: string;
  url: string;
  requestUrl: string;
  modifiedAt?: string;
  bodyHtml: string;
}

interface HtmlHeading {
  heading: string;
  level: number;
  boundary: number;
  start: number;
  end: number;
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (entity, encoded: string) => {
      if (encoded.startsWith("#x") || encoded.startsWith("#X")) {
        const codePoint = Number.parseInt(encoded.slice(2), 16);
          return Number.isFinite(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      if (encoded.startsWith("#")) {
        const codePoint = Number.parseInt(encoded.slice(1), 10);
          return Number.isFinite(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      return namedEntities[encoded.toLowerCase()] ?? entity;
    },
  );
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\b[^>]*>|<\/(?:p|div|li|h[1-6]|tr)>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function getAttribute(tag: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `\\b${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : decodeHtmlEntities(value);
}

function findMatchingElement(
  html: string,
  openTag: RegExpExecArray,
  tagName: string,
): HtmlElement | undefined {
  const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "gi");
  tagPattern.lastIndex = openTag.index;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html)) !== null) {
    const closing = /^<\//.test(match[0]);
    if (closing) {
      depth -= 1;
      if (depth === 0) {
        const start = openTag.index + openTag[0].length;
        const end = match.index;
        return { start, end: match.index + match[0].length, innerHtml: html.slice(start, end) };
      }
    } else if (!/\/>$/.test(match[0])) {
      depth += 1;
    }
  }
  return undefined;
}

function findElement(html: string, tagName: string): HtmlElement | undefined {
  const tagPattern = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html)) !== null) {
    const element = findMatchingElement(html, match, tagName);
    if (element) {
      return element;
    }
  }
  return undefined;
}

function findElementByClass(
  html: string,
  requiredClass: string,
): HtmlElement | undefined {
  const tagPattern = /<([a-z][\w:-]*)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html)) !== null) {
    const classes = getAttribute(match[0], "class")?.split(/\s+/) ?? [];
    if (!classes.includes(requiredClass)) {
      continue;
    }
    const element = findMatchingElement(html, match, match[1]);
    if (element) {
      return element;
    }
  }
  return undefined;
}

function normalizeTitle(title: string): string {
  return title
    .normalize("NFKC")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en");
}

function parsePage(html: string, requestedUrl: string): GrokipediaPage {
  const heading = findElement(html, "h1");
  const articleBody = findElementByClass(html, "article-body");
  if (!heading || !articleBody) {
    throw new Error(
      `Grokipedia page did not contain an article title and body: ${requestedUrl}`,
    );
  }
  const title = htmlToText(heading.innerHtml);
  if (!title) {
    throw new Error(`Grokipedia page contained an empty title: ${requestedUrl}`);
  }

  const canonicalTag = /<link\b[^>]*>/gi;
  let canonicalUrl = requestedUrl;
  let match: RegExpExecArray | null;
  while ((match = canonicalTag.exec(html)) !== null) {
    if (getAttribute(match[0], "rel")?.toLowerCase() !== "canonical") {
      continue;
    }
    const href = getAttribute(match[0], "href");
    if (!href) {
      continue;
    }
    const parsedUrl = new URL(href, requestedUrl);
    if (parsedUrl.hostname === grokipediaHost) {
      canonicalUrl = parsedUrl.href;
    }
    break;
  }

  const jsonLdDateModified =
    /"dateModified"\s*:\s*"([^"]+)"/i.exec(html)?.[1];
  const modifiedMeta =
    /<meta\b[^>]*property=["']article:modified_time["'][^>]*>/i.exec(html)?.[0];
  const modifiedAt =
    jsonLdDateModified ??
    (modifiedMeta ? getAttribute(modifiedMeta, "content") : undefined);
  return {
    title,
    url: canonicalUrl,
    requestUrl: requestedUrl,
    ...(modifiedAt ? { modifiedAt } : {}),
    bodyHtml: html.slice(articleBody.start, articleBody.end),
  };
}

function pageCitationUrls(bodyHtml: string, pageUrl: string): string[] {
  const urls = new Set<string>();
  const anchors = /<a\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchors.exec(bodyHtml)) !== null) {
    const href = getAttribute(match[0], "href");
    if (!href) {
      continue;
    }
    try {
      const url = new URL(href, pageUrl);
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.hostname !== grokipediaHost &&
        !url.hostname.endsWith(`.${grokipediaHost}`)
      ) {
        urls.add(url.href);
      }
    } catch {
      continue;
    }
  }
  return [...urls];
}

function sectionsFromHtml(
  bodyHtml: string,
  catalog: RgoGoodsCatalog,
): ResearchSection[] {
  const headings: HtmlHeading[] = [];
  const headingPattern = /<h([23])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(bodyHtml)) !== null) {
    const headingEnd = match.index + match[0].length;
    const nextHeading = headingPattern.lastIndex;
    headings.push({
      heading: htmlToText(match[2]),
      level: Number(match[1]),
      boundary: match.index,
      start: headingEnd,
      end: bodyHtml.length,
    });
    headingPattern.lastIndex = nextHeading;
  }
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const next = headings
      .slice(index + 1)
      .find((candidate) => candidate.level <= heading.level);
    heading.end = next ? next.boundary : bodyHtml.length;
  }

  const relevant = headings.filter((heading) =>
    isRelevantHeading(heading.heading),
  );
  const selected = relevant.filter(
    (heading) =>
      !relevant.some(
        (parent) =>
          parent.level < heading.level &&
          parent.start <= heading.start &&
          parent.end >= heading.end,
      ),
  );
  const sections = selected.map((heading) => {
    const content = bodyHtml.slice(heading.start, heading.end);
    return sectionResearch(
      heading.heading,
      htmlToText(content),
      "en",
      catalog,
      pageCitationUrls(content, grokipediaOrigin),
    );
  });
  if (sections.length > 0) {
    return sections;
  }

  const leadEnd = headings[0]?.start ?? bodyHtml.length;
  return [
    sectionResearch(
      "Lead",
      htmlToText(bodyHtml.slice(0, leadEnd)),
      "en",
      catalog,
      pageCitationUrls(bodyHtml.slice(0, leadEnd), grokipediaOrigin),
    ),
  ];
}

function exactSearchResultUrls(html: string, title: string): string[] {
  const urls: string[] = [];
  const anchors =
    /<a\b(?=[^>]*\bdata-search-result-link(?:\s*=\s*(?:"true"|'true'|true))?)[^>]*>[\s\S]*?<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchors.exec(html)) !== null) {
    const openingTag = /^<a\b[^>]*>/i.exec(match[0])?.[0];
    const href = openingTag ? getAttribute(openingTag, "href") : undefined;
    const label = htmlToText(match[0].replace(/^<a\b[^>]*>|<\/a>$/gi, ""));
    if (!href || normalizeTitle(label) !== normalizeTitle(title)) {
      continue;
    }
    const url = new URL(href, grokipediaOrigin);
    if (
      url.hostname === grokipediaHost &&
      url.pathname.startsWith("/page/")
    ) {
      urls.push(url.href);
    }
  }
  return [...new Set(urls)];
}

async function findExactPage(
  title: string,
  client: CachedHttpClient,
): Promise<GrokipediaPage | undefined> {
  const pageSlug = encodeURIComponent(title.replace(/\s+/g, "_"));
  const directUrl = new URL(`/page/${pageSlug}`, grokipediaOrigin).href;
  const directHtml = await client.getText(directUrl);
  if (directHtml !== null) {
    const page = parsePage(directHtml, directUrl);
    if (normalizeTitle(page.title) === normalizeTitle(title)) {
      return page;
    }
  }

  const searchUrl = new URL("/search", grokipediaOrigin);
  searchUrl.searchParams.set("q", title);
  const searchHtml = await client.getText(searchUrl.href);
  if (searchHtml === null) {
    return undefined;
  }
  for (const resultUrl of exactSearchResultUrls(searchHtml, title)) {
    const resultHtml = await client.getText(resultUrl);
    if (resultHtml === null) {
      continue;
    }
    const page = parsePage(resultHtml, resultUrl);
    if (normalizeTitle(page.title) === normalizeTitle(title)) {
      return page;
    }
  }
  return undefined;
}

export async function discoverGrokipediaPage(
  title: string,
  client: CachedHttpClient,
): Promise<DiscoveredResearchPage | undefined> {
  const page = await findExactPage(title, client);
  if (!page) {
    return undefined;
  }
  return {
    source: {
      provider: "grokipedia",
      language: "en",
      title: page.title,
      url: page.url,
    },
    retrievalMode: "grokipedia",
    fetchUrl: page.requestUrl,
  };
}

function researchPage(
  page: GrokipediaPage,
  catalog: RgoGoodsCatalog,
): ArticleResearch {
  const sections = sectionsFromHtml(page.bodyHtml, catalog);
  const notes = [
    "Grokipedia content is AI-generated; treat its claims as research leads and verify them against the linked references.",
  ];
  if (sections.every((section) => section.text.length === 0)) {
    notes.push("No readable prose was extracted from the selected page.");
  }
  return {
    source: {
      provider: "grokipedia",
      language: "en",
      title: page.title,
      url: page.url,
    },
    retrievalMode: "grokipedia",
    ...(page.modifiedAt ? { pageModifiedAt: page.modifiedAt } : {}),
    pageCitationUrls: pageCitationUrls(page.bodyHtml, page.url),
    sections,
    articleRgoMatches: aggregateCropMatches(sections),
    notes,
  };
}

export async function researchGrokipediaPage(
  discoveredPage: DiscoveredResearchPage,
  client: CachedHttpClient,
  catalog: RgoGoodsCatalog,
): Promise<ArticleResearch> {
  const fetchUrl = discoveredPage.fetchUrl ?? discoveredPage.source.url;
  const html = await client.getText(fetchUrl);
  if (html === null) {
    throw new Error(
      `Discovered Grokipedia page disappeared before retrieval: ${fetchUrl}`,
    );
  }
  const page = parsePage(html, fetchUrl);
  if (normalizeTitle(page.title) !== normalizeTitle(discoveredPage.source.title)) {
    throw new Error(
      `Grokipedia page title changed after discovery: ${discoveredPage.source.url}`,
    );
  }
  return researchPage(page, catalog);
}

export async function addGrokipediaEvidence(
  research: ResearchFile,
  client: CachedHttpClient,
  catalog: RgoGoodsCatalog,
): Promise<ResearchFile> {
  const locations: ResearchFile["locations"] = [];
  for (const location of research.locations) {
    const candidate = location.sources
      .find((source) => source.source.language === "en")?.source.title ??
      location.englishWikipediaTitle;
    const title = candidate ?? location.placeLabel;
    const discoveredPage = await discoverGrokipediaPage(title, client);
    if (!discoveredPage) {
      locations.push({
        ...location,
        notes: [
          ...location.notes,
          `No exact-title Grokipedia article was found for "${title}".`,
        ],
      });
      continue;
    }
    const article = await researchGrokipediaPage(
      discoveredPage,
      client,
      catalog,
    );
    locations.push({
      ...location,
      sources: [...location.sources, article],
    });
  }
  return { ...research, locations };
}
