# Tuber RGO research workflow

The research workflow prepares evidence and reviewable RGO candidates for
locations in [the tuber location review](../decisions/tuber-location-review.md).
It never changes assignments in game files. Candidate suggestions are leads
for review, not historical conclusions. The current review contains only two
provisional Cassava candidates carried over from Just Fruits, not a complete
location inventory.

## Local setup

Install the project's development dependencies with `npm install`. Configure
the installed EU5 game directory and local Just Goods source directory in the
ignored `.local/rgo-research.json` file:

```json
{
  "gamePath": "C:\\path\\to\\Europa Universalis V\\game",
  "justGoodsGoodsDirectory": "C:\\path\\to\\Just Goods\\game\\in_game\\common\\goods"
}
```

The game path must be the `game` directory containing `in_game`; the Just Goods
path must contain its raw-material definition `.txt` files. Alternatively,
set `EU5_GAME_PATH` and `JUST_GOODS_GOODS_PATH`, or pass `--game-path` and
`--just-goods-goods-path`. Machine-specific paths and API cache data remain
under ignored `.local/`.

## Three-stage workflow

1. Run `npm run rgo:research -- resolve`. The default input is the provisional
   tuber location review. The resolver reads each location's region, area, and
   province from the installed game's `in_game/map_data/definitions.txt`, then
   queries Wikidata for geographic place candidates and their Wikipedia
   sitelinks. It writes JSON, Markdown, and CSV reports under
   `reports/rgo-research/`.
2. Review every location and candidate in the CSV. Set `correct` to `TRUE` for
   one confirmed place candidate per location; leave all candidates `FALSE`
   when uncertain. The tool does not automatically choose a place.
3. Run `npm run rgo:research -- discover`, then
   `npm run rgo:research -- research`. Discovery checks linked Wikipedia and
   Grokipedia page availability; research fetches cited sections, extracts
   history, economy, agriculture, trade, and industry evidence, and matches
   configured crop aliases. Review the generated reports and mark
   `valid_rgo` manually; every value starts `FALSE`.

Resolution accepts `--input locations.json` for a custom subset, with an array
of objects containing stable `id`, `englishName`, and `context` strings.
`discover` accepts `--resolution path.json` and `--review path.csv`;
`research` accepts `--discovery path.json`. Output paths are resolved from the
repository root.

## Candidate goods and interpretation

Selectable candidates are raw-material goods defined by installed vanilla
EU5, raw-material goods defined by the local Just Goods source, and the three
planned Just Tubers goods in `config/rgo-research-crops.json`: cassava, taro,
and sweet potato. Generic `fruit` is not a tuber candidate. Historical RGOs -
Global, RGO Harmony, and other mods are not candidate sources.

The starting date is 1337. Evidence must distinguish local cultivation before
that date from subsequent crop diffusion. Modern cultivation does not prove a
1337 starting RGO, and an article's regional mention is not automatically
evidence for every EU5 location in that region. A missing keyword match is not
evidence that a crop was absent.

The workflow uses literal configured keywords rather than semantic
classification. Wikipedia excerpts are attributed to the linked page and
revision; follow CC BY-SA terms if redistributing excerpts. Grokipedia content
is AI-generated and should only be treated as a lead to verify against linked
references. Check applicable terms before redistributing any excerpts.

## Source notes

- `npm test` runs the focused research workflow tests.
- `npm run typecheck` checks the TypeScript scripts and tests.
- `npm run rgo:research:index` regenerates country administrative-scale hints.
- Successful API responses and public-page responses are cached under ignored
  `.local/rgo-research/`.

Vanilla game files are read-only inputs. The research scripts read map and
raw-material definitions but never copy or modify them. Generated reports are
local review artifacts, not source decisions.
