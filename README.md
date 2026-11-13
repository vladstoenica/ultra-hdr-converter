# Ultra HDR Converter

Bulk-convert ordinary photos (JPEG/PNG/WebP) into **Ultra HDR JPEGs**: a normal JPEG plus an embedded gain map, so highlights glow on HDR screens (recent Android phones, Chrome on HDR monitors, Apple devices that read gain maps). Older viewers just see the normal photo.

Everything runs in the browser. No uploads, no server, no dependencies.

## How it works

1. Your original JPEG is kept **bit-for-bit** (EXIF and ICC are preserved; old XMP and gain maps are replaced).
2. A gain map is synthesized from the highlights, Lightroom-style "HDR from SDR":
   a smooth curve (in perceived brightness) starts at *Boost starts at*, reaches into the midtones per *Spread into mids*, and peaks at *Highlight boost* stops for white.
3. The file is assembled per the [Ultra HDR v1 spec](https://developer.android.com/media/platform/hdr-image-format):
   primary JPEG + `hdrgm` XMP + MPF index + gain map JPEG.

| File | Purpose |
|---|---|
| `index.html` | UI |
| `js/app.js` | file queue, conversion loop, zip/share |
| `js/gainmap.js` | gain map generation (handles EXIF orientation) |
| `js/ultrahdr.js` | JPEG parsing + Ultra HDR container writer |
| `js/zip.js` | tiny ZIP writer |

## Run locally

ES modules need a web server (not `file://`):

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Host for free (GitHub Pages)

1. Push this folder to a GitHub repo.
2. Repo → Settings → Pages → Source: *Deploy from a branch* → `main` / root.
3. Open `https://<your-username>.github.io/<repo>/`. On Android Chrome you can "Add to Home screen".

## Limits

- The HDR is **synthesized**: blown-out areas become bright blown-out areas. For real HDR, export from RAW with Lightroom's HDR output.
- HEIC input only works in browsers that can decode HEIC (Safari).
- Default output uses Google/Adobe `hdrgm` XMP metadata (verified HDR on Samsung and iPhone). ISO 21496-1 output is available under Advanced but currently doesn't render as HDR on iPhone.
- Bump the `?v=N` in `index.html` / `js/app.js` imports on every change, so phones don't serve stale cached files.
