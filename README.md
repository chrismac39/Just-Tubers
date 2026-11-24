# Just Tubers

Just Tubers is the project repository for an EU5 RGO mod focused on tuber and
root-crop agriculture. The initial roster is cassava, taro, and sweet potato.
Artwork and research tooling are scaffolded; game definitions, location
assignments, balancing, and production changes have not yet been implemented.

The design treats crop origins and later diffusion as separate historical
questions. The initial location review carries over two provisional Cassava
proposals from Just Fruits; it is not a complete location inventory.

See the [design notes](docs/RGO-Tubers-Design.md),
[location review](decisions/tuber-location-review.md),
[asset workflow](docs/assets.md), and
[research workflow](docs/rgo-research.md) before changing these materials.
The Workshop page and change note are placeholders, and no thumbnail has been
created yet. Publishing is not performed by repository or build operations.

## Contributing

Use the installed EU5 files as the source of truth for game syntax and
definitions. Treat vanilla files as read-only, follow `.editorconfig` for
game-content encoding, and validate the final assembled mod before release.
Document the evidence and rationale for location decisions, and do not publish
without explicit human confirmation.
