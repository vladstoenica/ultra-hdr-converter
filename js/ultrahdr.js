// Ultra HDR (JPEG + gain map) container writer.
// Spec: https://developer.android.com/media/platform/hdr-image-format
// Layout of output file:
//   [primary JPEG: SOI, (APP0/Exif), XMP(hdrgm + GContainer), MPF, ...rest..., EOI][gain map JPEG]

const XMP_NS = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXT_NS = 'http://ns.adobe.com/xmp/extension/\0';
const ISO_NS = 'urn:iso:std:iso:ts:21496:-1\0';
const enc = new TextEncoder();

function startsWith(bytes, offset, str) {
  for (let i = 0; i < str.length; i++) {
    if (bytes[offset + i] !== str.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Walks the JPEG marker structure.
 * Returns { header: [{marker, start, end, dataStart}], scanStart, end }
 *   header   – segments before the first SOS (metadata, tables, SOF)
 *   scanStart – offset of first SOS marker
 *   end      – offset just after the primary image's EOI (anything after is trailing data)
 */
export function parseJpeg(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Not a JPEG file');
  const n = bytes.length;
  const header = [];
  let i = 2;
  let scanStart = -1;
  while (i < n) {
    if (bytes[i] !== 0xff) throw new Error(`Corrupt JPEG: expected marker at ${i}`);
    while (bytes[i + 1] === 0xff) i++; // fill bytes
    const marker = bytes[i + 1];
    if (marker === 0xd9) return { header, scanStart, end: i + 2 };
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    const segEnd = i + 2 + len;
    if (scanStart < 0 && marker !== 0xda) {
      header.push({ marker, start: i, end: segEnd, dataStart: i + 4 });
    }
    if (marker === 0xda) {
      if (scanStart < 0) scanStart = i;
      // Skip entropy-coded data until the next real marker.
      let j = segEnd;
      while (j < n) {
        if (bytes[j] === 0xff) {
          const nx = bytes[j + 1];
          if (nx === 0x00 || (nx >= 0xd0 && nx <= 0xd7)) { j += 2; continue; }
          if (nx === 0xff) { j += 1; continue; }
          break;
        }
        j++;
      }
      i = j;
    } else {
      i = segEnd;
    }
  }
  throw new Error('Corrupt JPEG: no EOI marker');
}

/** Reads the EXIF orientation (1..8) from a parsed JPEG. Returns 1 if absent. */
export function readOrientation(bytes, parsed) {
  for (const s of parsed.header) {
    if (s.marker !== 0xe1 || !startsWith(bytes, s.dataStart, 'Exif\0\0')) continue;
    const t = s.dataStart + 6;
    const le = bytes[t] === 0x49; // 'II'
    const u16 = (o) => (le ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
    const u32 = (o) => (le
      ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
      : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0);
    const ifd = t + u32(t + 4);
    if (ifd + 2 > s.end) return 1;
    const count = u16(ifd);
    for (let k = 0; k < count; k++) {
      const e = ifd + 2 + k * 12;
      if (e + 12 > s.end) break;
      if (u16(e) === 0x0112) {
        const v = u16(e + 8);
        return v >= 1 && v <= 8 ? v : 1;
      }
    }
  }
  return 1;
}

/** Heuristic: does this JPEG already carry an HDR gain map (Google, Adobe, ISO or Apple)? */
export function hasGainMap(bytes, parsed) {
  for (const s of parsed.header) {
    if (s.marker === 0xe1 && startsWith(bytes, s.dataStart, XMP_NS)) {
      const xmp = new TextDecoder().decode(bytes.subarray(s.dataStart, s.end));
      if (xmp.includes('hdrgm:') || xmp.includes('HDRGainMap')) return true;
    }
    if (s.marker === 0xe2 && startsWith(bytes, s.dataStart, ISO_NS)) return true;
  }
  if (parsed.end < bytes.length - 64) {
    const tail = new TextDecoder('latin1').decode(bytes.subarray(parsed.end, Math.min(bytes.length, parsed.end + 65536)));
    if (tail.includes('hdrgm') || tail.includes('HDRGainMap') || tail.includes('urn:iso:std:iso:ts:21496')) return true;
  }
  return false;
}

function app1Xmp(xml) {
  const ns = enc.encode(XMP_NS);
  const body = enc.encode(xml);
  const len = 2 + ns.length + body.length;
  if (len > 0xffff) throw new Error('XMP too large');
  const seg = new Uint8Array(2 + len);
  seg[0] = 0xff; seg[1] = 0xe1; seg[2] = len >> 8; seg[3] = len & 0xff;
  seg.set(ns, 4);
  seg.set(body, 4 + ns.length);
  return seg;
}

function primaryXmp(gainMapLength) {
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="UltraHDR Converter">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:Container="http://ns.google.com/photos/1.0/container/"
    xmlns:Item="http://ns.google.com/photos/1.0/container/item/"
    xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"
    hdrgm:Version="1.0">
   <Container:Directory>
    <rdf:Seq>
     <rdf:li rdf:parseType="Resource">
      <Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/>
     </rdf:li>
     <rdf:li rdf:parseType="Resource">
      <Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${gainMapLength}"/>
     </rdf:li>
    </rdf:Seq>
   </Container:Directory>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
}

function gainMapXmp(m) {
  const f = (x) => String(+x.toFixed(6));
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="UltraHDR Converter">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"
    hdrgm:Version="1.0"
    hdrgm:GainMapMin="${f(m.gainMapMin)}"
    hdrgm:GainMapMax="${f(m.gainMapMax)}"
    hdrgm:Gamma="${f(m.gamma)}"
    hdrgm:OffsetSDR="${f(m.offsetSdr)}"
    hdrgm:OffsetHDR="${f(m.offsetHdr)}"
    hdrgm:HDRCapacityMin="${f(m.hdrCapacityMin)}"
    hdrgm:HDRCapacityMax="${f(m.hdrCapacityMax)}"
    hdrgm:BaseRenditionIsHDR="False"/>
 </rdf:RDF>
</x:xmpmeta>`;
}

function app2(ns, payload) {
  const nsb = enc.encode(ns);
  const len = 2 + nsb.length + payload.length;
  const seg = new Uint8Array(2 + len);
  seg[0] = 0xff; seg[1] = 0xe2; seg[2] = len >> 8; seg[3] = len & 0xff;
  seg.set(nsb, 4);
  seg.set(payload, 4 + nsb.length);
  return seg;
}

// ISO 21496-1: the primary image only carries the version (minimum_version=0, writer_version=0).
function isoVersionSeg() {
  return app2(ISO_NS, new Uint8Array(4));
}

// ISO 21496-1 full metadata for the gain map image.
// Single channel, explicit numerator/denominator per value (the general form every parser supports).
function isoGainMapSeg(m) {
  const D = 1 << 16;
  const buf = new Uint8Array(4 + 1 + 2 * 8 + 5 * 8);
  const dv = new DataView(buf.buffer);
  let p = 0;
  const u = (x) => { dv.setUint32(p, Math.round(x * D)); dv.setUint32(p + 4, D); p += 8; };
  const s = (x) => { dv.setInt32(p, Math.round(x * D)); dv.setUint32(p + 4, D); p += 8; };
  dv.setUint16(p, 0); p += 2; // minimum_version
  dv.setUint16(p, 0); p += 2; // writer_version
  dv.setUint8(p, 0x40); p += 1; // flags: use base colour space
  u(m.hdrCapacityMin); // base_hdr_headroom
  u(m.hdrCapacityMax); // alternate_hdr_headroom
  s(m.gainMapMin);
  s(m.gainMapMax);
  u(m.gamma);
  s(m.offsetSdr); // base_offset
  s(m.offsetHdr); // alternate_offset
  return app2(ISO_NS, buf);
}

const MPF_SEG_LEN = 90; // FF E2 + len(2) + "MPF\0" + 82 bytes TIFF/MP data

function writeMpf(out, segStart, primarySize, gainMapSize) {
  const dv = new DataView(out.buffer, out.byteOffset + segStart, MPF_SEG_LEN);
  dv.setUint16(0, 0xffe2);
  dv.setUint16(2, MPF_SEG_LEN - 2);
  out.set(enc.encode('MPF\0'), segStart + 4);
  const h = 8; // TIFF header start within segment
  dv.setUint16(h, 0x4d4d); // big endian 'MM'
  dv.setUint16(h + 2, 0x002a);
  dv.setUint32(h + 4, 8); // first IFD offset
  let p = h + 8;
  dv.setUint16(p, 3); p += 2;
  // MPFVersion
  dv.setUint16(p, 0xb000); dv.setUint16(p + 2, 7); dv.setUint32(p + 4, 4);
  out.set(enc.encode('0100'), segStart + p + 8); p += 12;
  // NumberOfImages
  dv.setUint16(p, 0xb001); dv.setUint16(p + 2, 4); dv.setUint32(p + 4, 1); dv.setUint32(p + 8, 2); p += 12;
  // MPEntry
  dv.setUint16(p, 0xb002); dv.setUint16(p + 2, 7); dv.setUint32(p + 4, 32); dv.setUint32(p + 8, 50); p += 12;
  dv.setUint32(p, 0); p += 4; // next IFD
  // MP entries (offsets are relative to the TIFF header start)
  const mpHeaderPos = segStart + h;
  dv.setUint32(p, 0x00030000); dv.setUint32(p + 4, primarySize); dv.setUint32(p + 8, 0);
  dv.setUint16(p + 12, 0); dv.setUint16(p + 14, 0); p += 16;
  dv.setUint32(p, 0x00000000); dv.setUint32(p + 4, gainMapSize); dv.setUint32(p + 8, primarySize - mpHeaderPos);
  dv.setUint16(p + 12, 0); dv.setUint16(p + 14, 0);
}

function concat(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Adds gain map metadata to the gain map JPEG, mirroring libultrahdr's layout:
 * SOI, APP0 JFIF, XMP (hdrgm), ISO 21496-1, then tables + scan. The ICC profile the
 * browser's encoder adds is dropped (gain map values are data, not colour).
 */
function addMetadataToGainMap(gmBytes, meta, fmt) {
  const parsed = parseJpeg(gmBytes);
  const isIcc = (s) => s.marker === 0xe2 && startsWith(gmBytes, s.dataStart, 'ICC_PROFILE\0');
  const jfif = parsed.header.filter((s) => s.marker === 0xe0);
  const rest = parsed.header.filter((s) => s.marker !== 0xe0 && !isIcc(s));
  return concat([
    gmBytes.subarray(0, 2),
    ...jfif.map((s) => gmBytes.subarray(s.start, s.end)),
    ...(fmt.xmp ? [app1Xmp(gainMapXmp(meta))] : []),
    ...(fmt.iso ? [isoGainMapSeg(meta)] : []),
    ...rest.map((s) => gmBytes.subarray(s.start, s.end)),
    gmBytes.subarray(parsed.scanStart, parsed.end),
  ]);
}

/**
 * Builds an Ultra HDR JPEG.
 * @param {Uint8Array} primary  original JPEG bytes (kept bit-exact, except old XMP/MPF/gain map removed)
 * @param {Uint8Array} gainMap  gain map encoded as JPEG
 * @param {object} meta         gain map metadata (log2 units)
 * @param {{xmp:boolean, iso:boolean}} fmt  which metadata flavours to write
 */
export function buildUltraHdr(primary, gainMap, meta, fmt = { xmp: true, iso: true }) {
  const parsed = parseJpeg(primary);
  const gm = addMetadataToGainMap(gainMap, meta, fmt);

  const lead = [];
  const rest = [];
  let leading = true;
  for (const s of parsed.header) {
    const isXmp = s.marker === 0xe1 && (startsWith(primary, s.dataStart, XMP_NS) || startsWith(primary, s.dataStart, XMP_EXT_NS));
    const isMpf = s.marker === 0xe2 && startsWith(primary, s.dataStart, 'MPF\0');
    const isIso = s.marker === 0xe2 && startsWith(primary, s.dataStart, ISO_NS);
    if (isXmp || isMpf || isIso) continue; // replaced by our own metadata
    const isLeadSeg = s.marker === 0xe0 || (s.marker === 0xe1 && startsWith(primary, s.dataStart, 'Exif\0\0'));
    if (leading && isLeadSeg) lead.push(primary.subarray(s.start, s.end));
    else { leading = false; rest.push(primary.subarray(s.start, s.end)); }
  }

  const xmpSeg = app1Xmp(primaryXmp(gm.length));
  const mpfSeg = new Uint8Array(MPF_SEG_LEN);
  const soi = primary.subarray(0, 2);
  const scan = primary.subarray(parsed.scanStart, parsed.end);
  const head = concat([soi, ...lead, ...(fmt.xmp ? [xmpSeg] : []), ...(fmt.iso ? [isoVersionSeg()] : [])]);
  const primaryOut = concat([head, mpfSeg, ...rest, scan]);
  writeMpf(primaryOut, head.length, primaryOut.length, gm.length);
  return concat([primaryOut, gm]);
}
