# Just Tubers design

## Status and scope

Just Tubers is a standalone EU5 RGO project for crops whose edible yield is
primarily harvested from underground storage organs. The initial roster is
cassava, taro, and sweet potato. This is a design scaffold: no game goods,
location assignments, balancing, or production changes have been implemented.

The target timeframe is 1337–1836. Native cultivation at the 1337 start and
later crop diffusion must be researched separately; modern cultivation alone
does not establish a starting RGO.

## Initial crop roster

| Good | Design intent |
| --- | --- |
| Cassava | Represent cassava/manioc as a distinct crop with its New World origin and later Old World diffusion modeled explicitly. |
| Taro | Represent taro and related cultivation as a distinct Old World crop system. |
| Sweet Potato | Keep sweet potato distinct from vanilla potato so its New World origin, warm-climate food role, and post-contact spread can be modeled. |

These are separate goods because they support different geographic and
historical patterns, not because every botanical variety warrants its own RGO.
The exact boundaries of related crops and their food output remain open design
questions.

## Location decisions

The location review currently contains only two provisional Cassava
suggestions carried over from Just Fruits: Biobio and Sachchaa Mukku. They are
leads for review, not approved assignments. A complete candidate inventory
and decisions for all three crops remain to be developed.

For the New World review, use existing `legumes` RGOs across most of Central
and South America as priority candidates for replacement with cassava or sweet
potato. This is a regional design direction rather than an automatic mapping:
choose between the two crops from start-date and location-specific evidence,
and retain legumes where the evidence supports them.

For each location, distinguish pre-1337 cultivation from later diffusion,
require location-specific evidence where available, and keep uncertain
regional evidence visible. Vanilla potato remains a separate crop and should
not be treated as an automatic substitute for sweet potato.

## Crop diffusion and RGO switching

Just Tubers should provide specific player-facing options for switching
eligible locations to cassava, taro, or sweet potato RGOs after those crops
become available. Conversion should require appropriate historical contact,
climate, timing, ownership, market access, and costs rather than functioning
as unrestricted RGO replacement.

Scripted AI events should provide a parallel path for historically plausible
crop diffusion, including movement between the Old and New Worlds and the
development of colonial plantation monocultures where appropriate. This
system should coordinate with Just Fruits so both projects apply compatible
eligibility principles, pacing, and AI behavior.

Player options and AI events should not overwrite historically important RGOs
without meaningful conditions. Exact triggers, effects, pacing, and AI
weighting must be verified against installed vanilla definitions before
implementation.
