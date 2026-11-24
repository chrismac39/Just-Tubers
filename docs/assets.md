# Image assets

The synthesis artwork is stored in this repository under
`main_menu/gfx/interface/icons/`. The `trade_goods` and `modifier_types`
directories contain the base goods icons and their modifier variants;
`trade_goods/illustrations` contains the larger goods illustrations.

The compositor, vanilla-icon importer, and DDS converter are maintained in
the sibling [EU5 Image Tools](https://github.com/chrismac39/eu5-image-tools)
repository. From that repository, set `$modRoot` to this checkout and use:

```powershell
$modRoot = "C:\path\to\Just-Tubers"
$graphics = Join-Path $modRoot "main_menu\gfx"
$goods = Join-Path $graphics "interface\icons\trade_goods"
$modifierTypes = Join-Path $graphics "interface\icons\modifier_types"

foreach ($modifier in @("positive", "negative", "inflation", "pop_demand")) {
  & .\.venv\Scripts\python.exe scripts\assets\build_modifier_icons.py `
    --all-goods --modifier $modifier `
    --source-dir $goods `
    --modifier-dir input\modifiers `
    --output-dir $modifierTypes `
    --overwrite
}

& .\.venv\Scripts\python.exe scripts\assets\convert_rgo_images.py `
  --source $graphics --dds-output $graphics
```

Vanilla game files are read-only. Use the standalone importer to copy a
selected vanilla icon into the image-tools repository's ignored
`input/modifiers/` directory before composing it into a project asset. Record
the source and redistribution terms for any externally sourced artwork.
