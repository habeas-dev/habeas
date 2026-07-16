# Habeas logo — PNG exports

The Habeas mark (the "H" monogram with the orange bar). Square, transparent background,
rendered from the source SVGs (`extension/icon.svg` / `extension/icon-dark.svg`).

Two ink variants, at fixed square resolutions **16, 32, 48, 64, 128, 256, 512, 1024** px:

| Variant | Ink color | Use on | File |
|---------|-----------|--------|------|
| **dark**  | `#14453d` (deep green) | **light** backgrounds | `habeas-logo-dark-<size>.png` |
| **light** | `#eef4f1` (off-white)  | **dark** backgrounds  | `habeas-logo-light-<size>.png` |

The orange crossbar (`#e08a3c`) is the same in both.

To regenerate (needs Inkscape or ImageMagick):

```sh
for s in 16 32 48 64 128 256 512 1024; do
  inkscape extension/icon.svg      --export-type=png --export-filename=docs/logos/habeas-logo-dark-$s.png  -w $s -h $s
  inkscape extension/icon-dark.svg --export-type=png --export-filename=docs/logos/habeas-logo-light-$s.png -w $s -h $s
done
```
