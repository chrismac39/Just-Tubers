import { readFile } from "node:fs/promises";

export interface Eu5Province {
  id: string;
  name: string;
  areaId?: string;
  areaName?: string;
  regionId?: string;
  regionName?: string;
}

function displayMapName(id: string): string {
  return id
    .replace(/_(?:province|area|region)$/, "")
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

interface DefinitionNode {
  id: string;
  children: DefinitionNode[];
  values: string[];
}

function parseDefinitions(contents: string): DefinitionNode {
  const normalized = contents.replace(/#[^\r\n]*/g, "");
  const tokens = normalized.match(/"(?:\\.|[^"\\])*"|[{}=]|[^\s{}=]+/g) ?? [];
  let index = 0;

  function parseNode(id: string, closing: boolean): DefinitionNode {
    const node: DefinitionNode = { id, children: [], values: [] };
    while (index < tokens.length) {
      const token = tokens[index];
      if (token === "}") {
        if (!closing) {
          throw new Error("Unexpected closing brace in EU5 definitions");
        }
        index += 1;
        return node;
      }
      if (token === "{" || token === "=") {
        throw new Error(`Unexpected ${token} in EU5 definitions`);
      }
      if (tokens[index + 1] === "=") {
        const key = token;
        index += 2;
        if (index >= tokens.length) {
          throw new Error(`Missing value for ${key} in EU5 definitions`);
        }
        if (tokens[index] === "{") {
          index += 1;
          node.children.push(parseNode(key, true));
        } else {
          index += 1;
        }
      } else {
        node.values.push(token);
        index += 1;
      }
    }
    if (closing) {
      throw new Error(`Unclosed block ${id} in EU5 definitions`);
    }
    return node;
  }

  return parseNode("ROOT", false);
}

export function parseEu5ProvinceMap(
  definitions: string,
): Map<string, Eu5Province> {
  const locations = new Map<string, Eu5Province>();
  const root = parseDefinitions(definitions);

  function visit(node: DefinitionNode): void {
    const hasRegionShape = node.children.some((area) =>
      area.children.some((province) => province.values.length > 0),
    );
    if (hasRegionShape) {
      for (const area of node.children) {
        for (const provinceNode of area.children) {
          const province: Eu5Province = {
            id: provinceNode.id,
            name: displayMapName(provinceNode.id),
            areaId: area.id,
            areaName: displayMapName(area.id),
            regionId: node.id,
            regionName: displayMapName(node.id),
          };

          function addLocations(scope: DefinitionNode): void {
            for (const locationId of scope.values) {
              const previousProvince = locations.get(locationId);
              if (previousProvince && previousProvince.id !== province.id) {
                throw new Error(
                  `EU5 location ${locationId} appears in both ${previousProvince.id} and ${province.id}`,
                );
              }
              locations.set(locationId, province);
            }
            scope.children.forEach(addLocations);
          }

          addLocations(provinceNode);
        }
      }
    }
    node.children.forEach(visit);
  }
  visit(root);

  if (locations.size === 0) {
    throw new Error("No EU5 province-to-location mappings were found");
  }
  return locations;
}

export async function readEu5ProvinceMap(
  definitionsPath: string,
): Promise<Map<string, Eu5Province>> {
  let definitions: string;
  try {
    definitions = await readFile(definitionsPath, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(
        `Could not find EU5 province definitions at ${definitionsPath}. Set EU5_GAME_PATH or pass --game-path.`,
      );
    }
    throw error;
  }
  return parseEu5ProvinceMap(definitions);
}

export function addEu5Provinces<
  T extends {
    id: string;
    eu5Province?: string;
    eu5ProvinceId?: string;
    eu5Area?: string;
    eu5AreaId?: string;
    eu5Region?: string;
    eu5RegionId?: string;
  },
>(
  locations: T[],
  provinceMap: Map<string, Eu5Province>,
): Array<
  T & {
    eu5Province: string;
    eu5ProvinceId: string;
    eu5Area?: string;
    eu5AreaId?: string;
    eu5Region?: string;
    eu5RegionId?: string;
  }
> {
  return locations.map((location) => {
    const province = provinceMap.get(location.id);
    if (!province) {
      throw new Error(
        `EU5 location ${location.id} has no province in definitions.txt`,
      );
    }
    if (location.eu5ProvinceId && location.eu5ProvinceId !== province.id) {
      throw new Error(
        `EU5 province mismatch for ${location.id}: input says ${location.eu5ProvinceId}, game definitions say ${province.id}`,
      );
    }
    if (location.eu5AreaId && location.eu5AreaId !== province.areaId) {
      throw new Error(
        `EU5 area mismatch for ${location.id}: input says ${location.eu5AreaId}, game definitions say ${province.areaId ?? "none"}`,
      );
    }
    if (location.eu5RegionId && location.eu5RegionId !== province.regionId) {
      throw new Error(
        `EU5 region mismatch for ${location.id}: input says ${location.eu5RegionId}, game definitions say ${province.regionId ?? "none"}`,
      );
    }
    return {
      ...location,
      eu5Province: province.name,
      eu5ProvinceId: province.id,
      ...(province.areaId && province.areaName
        ? { eu5Area: province.areaName, eu5AreaId: province.areaId }
        : {}),
      ...(province.regionId && province.regionName
        ? { eu5Region: province.regionName, eu5RegionId: province.regionId }
        : {}),
    };
  });
}
