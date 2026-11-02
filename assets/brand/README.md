# Brand assets

`hypergolic-logo.png` is the original 1254 × 1254 transparent PNG, preserved
byte-for-byte. SHA-256:
`16fcc05023863f81bbc74395fb039b59f9634fef0930f370541a979979b92448`.

Keep its square canvas, aspect ratio and original colours. Do not crop the mark
or add a surrounding shape. The shell and first-entry screen use the original.

The 1024 × 1024 launcher derivatives preserve the mark:

- `app-icon.png`: opaque `#140f0b` background, original canvas centred at 800 pixels.
- `app-icon-foreground.png`: transparent, original canvas centred at 620 pixels
  within Android's adaptive safe zone.
- `app-icon-monochrome.png`: the foreground alpha as a white monochrome layer.

`app.json` owns platform icon configuration. Expo prebuild regenerates native
resources from these assets. Keep the originals unchanged when editing UI layout.
