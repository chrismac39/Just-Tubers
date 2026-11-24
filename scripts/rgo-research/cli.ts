import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CachedHttpClient } from "./api.js";
import {
  parseLocationInput,
  parseResolutionReviewCsv,
  parseResolutionFile,
  readTuberReviewLocations,
} from "./inventory.js";
import { loadRgoGoodsCatalog } from "./crops.js";
import { writeResearchReports, writeResolutionReports } from "./report.js";
import { writeResearchDiscoveryReport } from "./report.js";
import { resolveLocations } from "./wikidata.js";
import {
  discoverResearchPages,
  parseResearchDiscoveryFile,
  researchDiscoveredPages,
} from "./research.js";
import { addEu5Provinces, readEu5ProvinceMap } from "./provinces.js";
import { parseAdminScaleIndex } from "./admin-scale.js";

const defaultResolution = "reports/rgo-research/pilot-resolution.json";
const defaultDiscovery = "reports/rgo-research/pilot-discovery.json";
const defaultResearch = "reports/rgo-research/pilot-research.json";
const defaultInventory = "decisions/tuber-location-review.md";
const localConfigPath = ".local/rgo-research.json";

interface LocalConfig {
  gamePath?: string;
  justGoodsGoodsDirectory?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readLocalConfig(rootDirectory: string): Promise<LocalConfig> {
  let contents: string;
  try {
    contents = await readFile(path.join(rootDirectory, localConfigPath), "utf8");
  } catch (error) {
    if (
      isRecord(error) &&
      error.code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(contents);
  if (!isRecord(parsed)) {
    throw new Error(`${localConfigPath} must contain a JSON object`);
  }
  for (const key of ["gamePath", "justGoodsGoodsDirectory"] as const) {
    if (parsed[key] !== undefined && typeof parsed[key] !== "string") {
      throw new Error(`${localConfigPath} ${key} must be a string`);
    }
  }
  return {
    ...(typeof parsed.gamePath === "string"
      ? { gamePath: parsed.gamePath }
      : {}),
    ...(typeof parsed.justGoodsGoodsDirectory === "string"
      ? { justGoodsGoodsDirectory: parsed.justGoodsGoodsDirectory }
      : {}),
  };
}

function usage(): string {
  return [
    "Usage:",
    "  npm run rgo:research -- resolve [--input locations.json] [--output report.json] [--game-path GAME_DIR]",
    "  npm run rgo:research -- discover [--resolution report.json] [--review report.csv] [--output report.json]",
    "  npm run rgo:research -- research [--discovery report.json] [--output report.json] [--just-goods-goods-path GOODS_DIR]",
    "",
    "The default resolve input is the provisional Just Tubers location review.",
    "Only Wikidata entities classified as geographic locations are included.",
    "EU5 region, area, and province context are read from map_data/definitions.txt.",
    "Review the resolution CSV and set correct=TRUE for one confirmed candidate per location before research.",
    "Discover source pages before research; Wikipedia page existence is checked in batches of at most 50 titles.",
    "Country subdivision-scale hints come from config/rgo-research-admin-scales.json.",
    `Set local game and Just Goods paths in ${localConfigPath} or environment variables.`,
  ].join("\n");
}

function parseOptions(args: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}\n${usage()}`);
    }
    const equalsIndex = argument.indexOf("=");
    const name = equalsIndex >= 0 ? argument.slice(0, equalsIndex) : argument;
    const value =
      equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : args[index + 1];
    if (!value || value.startsWith("--") || options.has(name)) {
      throw new Error(
        `Option ${name} requires one value and may be specified once`,
      );
    }
    if (
      ![
        "--input",
        "--output",
        "--resolution",
        "--review",
        "--discovery",
        "--game-path",
        "--just-goods-goods-path",
      ].includes(name)
    ) {
      throw new Error(`Unknown option: ${name}\n${usage()}`);
    }
    options.set(name, value);
    if (equalsIndex < 0) {
      index += 1;
    }
  }
  return options;
}

async function main(): Promise<void> {
  const rootDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const [command, ...args] = process.argv.slice(2);
  if (!command || !["resolve", "discover", "research"].includes(command)) {
    throw new Error(usage());
  }
  const options = parseOptions(args);
  const localConfig = await readLocalConfig(rootDirectory);
  const cache = new CachedHttpClient({
    cachePath: path.join(
      rootDirectory,
      ".local",
      "rgo-research",
      "api-cache.json",
    ),
  });

  if (command === "resolve") {
    const gamePathValue =
      options.get("--game-path") ??
      process.env.EU5_GAME_PATH ??
      localConfig.gamePath;
    if (!gamePathValue) {
      throw new Error(
        `Set gamePath in ${localConfigPath}, EU5_GAME_PATH, or pass --game-path`,
      );
    }
    const gamePath = path.resolve(rootDirectory, gamePathValue);
    const provinceMap = await readEu5ProvinceMap(
      path.join(gamePath, "in_game", "map_data", "definitions.txt"),
    );
    if (options.has("--discovery")) {
      throw new Error("--discovery is only valid for research");
    }
    if (options.has("--resolution")) {
      throw new Error("--resolution is only valid for the research command");
    }
    if (options.has("--review")) {
      throw new Error("--review is only valid for the research command");
    }
    if (options.has("--just-goods-goods-path")) {
      throw new Error(
        "--just-goods-goods-path is only valid for the research command",
      );
    }
    const inputPath = options.get("--input");
    const inputLocations = inputPath
      ? parseLocationInput(
          JSON.parse(
            await readFile(path.resolve(rootDirectory, inputPath), "utf8"),
          ),
        )
      : await readTuberReviewLocations(
          path.join(rootDirectory, defaultInventory),
        );
    const locations = addEu5Provinces(inputLocations, provinceMap);
    const inputSource = inputPath
      ? path.relative(rootDirectory, path.resolve(rootDirectory, inputPath))
      : defaultInventory;
    const adminScaleIndex = parseAdminScaleIndex(
      JSON.parse(
        await readFile(
          path.join(rootDirectory, "config", "rgo-research-admin-scales.json"),
          "utf8",
        ),
      ),
    );
    const resolution = await resolveLocations(
      locations,
      cache,
      inputSource,
      adminScaleIndex,
    );
    await cache.flush();
    const output = await writeResolutionReports(
      rootDirectory,
      options.get("--output") ?? defaultResolution,
      resolution,
    );
    console.log(`Resolution JSON: ${output.jsonPath}`);
    console.log(`Review report: ${output.markdownPath}`);
    console.log(`Candidate review CSV: ${output.reviewCsvPath}`);
    console.log("Set correct=TRUE in the CSV for confirmed place candidates.");
    return;
  }

  if (command === "discover") {
    for (const option of [
      "--input",
      "--discovery",
      "--game-path",
      "--just-goods-goods-path",
    ]) {
      if (options.has(option)) {
        throw new Error(`${option} is not valid for the discover command`);
      }
    }
    const resolutionPath = path.resolve(
      rootDirectory,
      options.get("--resolution") ?? defaultResolution,
    );
    const parsedResolution = parseResolutionFile(
      JSON.parse(await readFile(resolutionPath, "utf8")),
    );
    const reviewPath = path.resolve(
      rootDirectory,
      options.get("--review") ?? resolutionPath.replace(/\.json$/i, ".csv"),
    );
    const resolution = parseResolutionReviewCsv(
      await readFile(reviewPath, "utf8"),
      parsedResolution,
    );
    const selectedCount = resolution.locations.filter(
      (location) => location.selectedQid !== null,
    ).length;
    if (selectedCount === 0) {
      throw new Error(
        "No locations are marked correct in the resolution CSV. Set correct=TRUE for at least one confirmed candidate first.",
      );
    }
    const discovery = await discoverResearchPages(
      resolution,
      cache,
      path.relative(rootDirectory, resolutionPath),
    );
    await cache.flush();
    const output = await writeResearchDiscoveryReport(
      rootDirectory,
      options.get("--output") ?? defaultDiscovery,
      discovery,
    );
    console.log(`Discovery JSON: ${output.jsonPath}`);
    console.log(`Page availability report: ${output.markdownPath}`);
    return;
  }

  for (const option of ["--input", "--resolution", "--review", "--game-path"]) {
    if (options.has(option)) {
      throw new Error(`${option} is not valid for the research command`);
    }
  }
  const discoveryPath = path.resolve(
    rootDirectory,
    options.get("--discovery") ?? defaultDiscovery,
  );
  let discoveryContents: string;
  try {
    discoveryContents = await readFile(discoveryPath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      throw new Error(
        `No page discovery report exists at ${discoveryPath}; run the discover command first`,
      );
    }
    throw error;
  }
  const discovery = parseResearchDiscoveryFile(
    JSON.parse(discoveryContents),
  );
  const gamePathValue =
    process.env.EU5_GAME_PATH ?? localConfig.gamePath;
  if (!gamePathValue) {
    throw new Error(
      `Set gamePath in ${localConfigPath} or EU5_GAME_PATH before research`,
    );
  }
  const gamePath = path.resolve(rootDirectory, gamePathValue);
  const justGoodsGoodsDirectoryValue =
    options.get("--just-goods-goods-path") ??
    process.env.JUST_GOODS_GOODS_PATH ??
    localConfig.justGoodsGoodsDirectory;
  if (!justGoodsGoodsDirectoryValue) {
    throw new Error(
      `Set justGoodsGoodsDirectory in ${localConfigPath}, JUST_GOODS_GOODS_PATH, or pass --just-goods-goods-path`,
    );
  }
  const justGoodsGoodsDirectory = path.resolve(
    rootDirectory,
    justGoodsGoodsDirectoryValue,
  );
  const catalog = await loadRgoGoodsCatalog(
    path.join(rootDirectory, "config", "rgo-research-crops.json"),
    path.join(gamePath, "in_game", "common", "goods"),
    justGoodsGoodsDirectory,
  );
  const research = await researchDiscoveredPages(discovery, cache, catalog);
  await cache.flush();
  const output = await writeResearchReports(
    rootDirectory,
    options.get("--output") ?? defaultResearch,
    research,
  );
  console.log(`Research JSON: ${output.jsonPath}`);
  console.log(`Review report: ${output.markdownPath}`);
  console.log(`RGO suggestion review CSV: ${output.rgoReviewCsvPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
