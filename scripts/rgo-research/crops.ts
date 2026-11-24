import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CropMatch } from "./model.js";

type RgoSource = "vanilla" | "just-goods" | "just-tubers";

export interface RgoGood {
  id: string;
  sources: Set<RgoSource>;
  foodOutput: number | null;
  preferenceRank: number;
  aliasesByLanguage: Map<string, Set<string>>;
}

interface AliasEntry {
  id: string;
  aliases: Record<string, string[]>;
}

interface ResearchCropsConfig {
  version: 2;
  plannedRgos: AliasEntry[];
  availableRgoAliases: AliasEntry[];
}

export type RgoGoodsCatalog = Map<string, RgoGood>;

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9\u00c0-\u024f\u1e00-\u1eff]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function parseAliasEntries(value: unknown, key: string): AliasEntry[] {
  if (!Array.isArray(value)) {
    throw new Error(`RGO research config must define ${key} as an array`);
  }
  return value.map((entry, index) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("id" in entry) ||
      typeof entry.id !== "string" ||
      !("aliases" in entry) ||
      typeof entry.aliases !== "object" ||
      entry.aliases === null ||
      Array.isArray(entry.aliases)
    ) {
      throw new Error(`Invalid ${key} entry at index ${index}`);
    }

    const aliases: Record<string, string[]> = {};
    for (const [language, terms] of Object.entries(entry.aliases)) {
      if (!Array.isArray(terms) || !terms.every((term) => typeof term === "string")) {
        throw new Error(`Invalid aliases for ${entry.id} (${language})`);
      }
      aliases[language] = terms;
    }
    return { id: entry.id, aliases };
  });
}

async function loadConfig(path: string): Promise<ResearchCropsConfig> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 2
  ) {
    throw new Error(`Unsupported RGO research config version: ${path}`);
  }
  if (!("plannedRgos" in parsed) || !("availableRgoAliases" in parsed)) {
    throw new Error(`RGO research config is missing candidate lists: ${path}`);
  }
  return {
    version: 2,
    plannedRgos: parseAliasEntries(parsed.plannedRgos, "plannedRgos"),
    availableRgoAliases: parseAliasEntries(
      parsed.availableRgoAliases,
      "availableRgoAliases",
    ),
  };
}

function parseGoodsDefinitions(
  contents: string,
  source: RgoSource,
): Map<string, { foodOutput: number | null }> {
  const goods = new Map<string, { foodOutput: number | null }>();
  const text = contents.replace(/^\uFEFF/, "").replace(/#[^\r\n]*/g, "");
  const headers = [...text.matchAll(/^([a-z][a-z0-9_]*)\s*=\s*\{/gm)];

  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    const id = header[1];
    const start = (header.index ?? 0) + header[0].length;
    const end =
      index + 1 < headers.length
        ? (headers[index + 1].index ?? text.length)
        : text.length;
    const body = text.slice(start, end);

    if (!/^\s*category\s*=\s*raw_material\b/m.test(body)) {
      continue;
    }
    if (source !== "vanilla" && source !== "just-goods") {
      throw new Error(`Unexpected raw-material source ${source}`);
    }

    const foodMatch = body.match(/^\s*food\s*=\s*(-?\d+(?:\.\d+)?)\b/m);
    const foodOutput = foodMatch ? Number(foodMatch[1]) : null;
    if (foodOutput !== null && !Number.isFinite(foodOutput)) {
      throw new Error(`Invalid food output for ${id}`);
    }
    goods.set(id, { foodOutput });
  }
  return goods;
}

async function loadGoodsDirectory(
  directory: string,
  source: "vanilla" | "just-goods",
): Promise<Map<string, { foodOutput: number | null }>> {
  const goods = new Map<string, { foodOutput: number | null }>();
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".txt"))
    .sort();
  if (files.length === 0) {
    throw new Error(`No goods definition files found in ${directory}`);
  }

  for (const file of files) {
    const definitions = parseGoodsDefinitions(
      await readFile(join(directory, file), "utf8"),
      source,
    );
    for (const [id, definition] of definitions) {
      const previous = goods.get(id);
      if (previous && previous.foodOutput !== definition.foodOutput) {
        throw new Error(
          `Conflicting food output for ${id} in ${directory}`,
        );
      }
      goods.set(id, {
        foodOutput: previous?.foodOutput ?? definition.foodOutput,
      });
    }
  }
  return goods;
}

function mergeSource(
  catalog: Map<string, RgoGood>,
  id: string,
  source: "vanilla" | "just-goods",
  foodOutput: number | null,
): void {
  if (id === "fruit") {
    return;
  }
  const existing = catalog.get(id);
  if (existing) {
    existing.sources.add(source);
    if (source === "just-goods" || existing.foodOutput === null) {
      existing.foodOutput = foodOutput;
    }
    existing.preferenceRank =
      existing.foodOutput !== null && existing.foodOutput > 0 ? 2 : 3;
    return;
  }
  catalog.set(id, {
    id,
    sources: new Set([source]),
    foodOutput,
    preferenceRank: foodOutput !== null && foodOutput > 0 ? 2 : 3,
    aliasesByLanguage: new Map(),
  });
}

function addAliases(good: RgoGood, aliases: Record<string, string[]>): void {
  for (const [language, terms] of Object.entries(aliases)) {
    const normalized = good.aliasesByLanguage.get(language) ?? new Set<string>();
    for (const term of terms) {
      const value = normalizeText(term);
      if (value) {
        normalized.add(value);
      }
    }
    good.aliasesByLanguage.set(language, normalized);
  }
}

export async function loadRgoGoodsCatalog(
  configPath: string,
  vanillaGoodsDirectory: string,
  justGoodsDirectory: string,
): Promise<RgoGoodsCatalog> {
  const [config, vanillaGoods, justGoods] = await Promise.all([
    loadConfig(configPath),
    loadGoodsDirectory(vanillaGoodsDirectory, "vanilla"),
    loadGoodsDirectory(justGoodsDirectory, "just-goods"),
  ]);
  const catalog = new Map<string, RgoGood>();

  for (const [id, definition] of vanillaGoods) {
    mergeSource(catalog, id, "vanilla", definition.foodOutput);
  }
  for (const [id, definition] of justGoods) {
    mergeSource(catalog, id, "just-goods", definition.foodOutput);
  }

  for (const entry of config.plannedRgos) {
    if (
      entry.id === "fruit" ||
      !/^[a-z][a-z0-9_]*$/.test(entry.id) ||
      catalog.has(entry.id)
    ) {
      throw new Error(`Invalid or duplicate planned Just Tubers RGO: ${entry.id}`);
    }
    catalog.set(entry.id, {
      id: entry.id,
      sources: new Set(["just-tubers"]),
      foodOutput: null,
      preferenceRank: 1,
      aliasesByLanguage: new Map(),
    });
    addAliases(catalog.get(entry.id)!, entry.aliases);
  }

  const seenAliases = new Set<string>();
  for (const entry of config.availableRgoAliases) {
    const good = catalog.get(entry.id);
    if (!good || good.sources.has("just-tubers")) {
      throw new Error(
        `Alias entry ${entry.id} must refer to a vanilla or Just Goods raw material`,
      );
    }
    if (seenAliases.has(entry.id)) {
      throw new Error(`Duplicate available-RGO alias entry: ${entry.id}`);
    }
    seenAliases.add(entry.id);
    addAliases(good, entry.aliases);
  }

  for (const good of catalog.values()) {
    addAliases(good, { en: [good.id.replace(/_/g, " ")] });
  }
  return catalog;
}

function getAliases(good: RgoGood, language: string): Set<string> {
  const aliases = new Set(good.aliasesByLanguage.get(language) ?? []);
  for (const alias of good.aliasesByLanguage.get("en") ?? []) {
    aliases.add(alias);
  }
  return aliases;
}

export function matchCrops(
  text: string,
  language: string,
  catalog: RgoGoodsCatalog,
): CropMatch[] {
  const normalizedText = normalizeText(text);
  const matches: CropMatch[] = [];

  for (const good of catalog.values()) {
    let occurrenceCount = 0;
    let matchedAlias = "";
    for (const alias of getAliases(good, language)) {
      const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const occurrences = normalizedText.match(
        new RegExp(`(?:^|\\s)${escapedAlias}(?=\\s|$)`, "g"),
      );
      if (occurrences?.length) {
        occurrenceCount += occurrences.length;
        if (alias.length > matchedAlias.length) {
          matchedAlias = alias;
        }
      }
    }
    if (occurrenceCount > 0) {
      matches.push({
        goodId: good.id,
        alias: matchedAlias,
        occurrenceCount,
        source: [...good.sources].join(" + "),
        foodOutput: good.foodOutput,
        preferenceRank: good.preferenceRank,
      });
    }
  }

  return matches.sort(
    (left, right) =>
      left.preferenceRank - right.preferenceRank ||
      right.occurrenceCount - left.occurrenceCount ||
      left.goodId.localeCompare(right.goodId),
  );
}

export const matchRgoGoods = matchCrops;
