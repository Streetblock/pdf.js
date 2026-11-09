/* Copyright 2026 Streetblock
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { getJpxCodestream } from "./pdfa_jpx_inspection.js";

const SOC = 0xff4f,
  SIZ = 0xff51,
  COD = 0xff52,
  COC = 0xff53;
const QCD = 0xff5c,
  QCC = 0xff5d,
  RGN = 0xff5e,
  COM = 0xff64;
const SOT = 0xff90,
  SOP = 0xff91,
  EPH = 0xff92,
  SOD = 0xff93,
  EOC = 0xffd9;
const OPTIONAL = new Map([
  [0xff55, 4],
  [0xff57, 3],
  [0xff58, 3],
  [0xff5f, 9],
  [0xff60, 3],
  [0xff61, 3],
  [0xff63, 2],
]);
const MAIN_ONLY = new Set([0xff55, 0xff57, 0xff60, 0xff63]);
const TILE_ONLY = new Set([0xff58, 0xff61]);
const LATER_PART = new Set([0xff58, 0xff5f, 0xff61, COM]);

class CodestreamFinding extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fail(detail) {
  throw new CodestreamFinding("fail", detail);
}

function unknown(detail) {
  throw new CodestreamFinding("unknown", detail);
}

class CodestreamInspection {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.counts = {
      headerSegments: 0,
      tileParts: 0,
      tiles: 0,
      openEndedTileParts: 0,
    };
    this.tiles = new Map();
    this.pending = null;
    this.main = null;
    this.packedMain = false;
    this.packedTile = false;
  }

  marker(offset) {
    if (offset < 0 || offset + 2 > this.bytes.length) {
      fail("A codestream marker is truncated.");
    }
    if (this.bytes[offset] !== 255) {
      fail(
        "A header or declared tile-part boundary does not begin with a marker."
      );
    }
    return this.view.getUint16(offset);
  }

  segment(offset) {
    if (++this.counts.headerSegments > 8192) {
      unknown(
        "The codestream header segment count exceeds the inspection limit."
      );
    }
    if (offset + 4 > this.bytes.length) {
      fail("A marker segment length is truncated.");
    }
    const length = this.view.getUint16(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > this.bytes.length) {
      fail("A marker segment exceeds the original codestream bytes.");
    }
    return { data: offset + 4, length, end };
  }

  exact(segment, length) {
    if (segment.length !== length) {
      fail("A codestream marker segment has an invalid declared length.");
    }
  }

  minimum(segment, length) {
    if (segment.length < length) {
      fail("A codestream marker segment is too short.");
    }
  }

  component(segment) {
    const size = this.components < 257 ? 1 : 2;
    this.minimum(segment, 2 + size);
    const index =
      size === 1 ? this.bytes[segment.data] : this.view.getUint16(segment.data);
    if (index >= this.components) {
      fail("A marker segment refers to a component outside SIZ.");
    }
    return { index, size };
  }

  coding(segment, component = false) {
    const prefix = component ? this.component(segment).size : 0;
    const minimum = component ? 8 + prefix : 12;
    this.minimum(segment, minimum);
    const start = segment.data + prefix;
    const flags = this.bytes[start];
    if (flags & ~(component ? 1 : 7)) {
      fail(
        "The coding style has reserved flags outside the supported Part 1 syntax."
      );
    }
    const data = start + (component ? 1 : 5);
    const levels = this.bytes[data];
    const width = this.bytes[data + 1],
      height = this.bytes[data + 2];
    const style = this.bytes[data + 3],
      wavelet = this.bytes[data + 4];
    if (
      levels > 32 ||
      width > 8 ||
      height > 8 ||
      width + height > 8 ||
      wavelet > 1
    ) {
      fail(
        "The coding style declares invalid decomposition, code-block or wavelet fields."
      );
    }
    if (style & ~63) {
      this.pending =
        "Extended code-block coding is outside this structural inspection.";
    }
    if (
      !component &&
      (this.bytes[start + 1] > 4 ||
        !this.view.getUint16(start + 2) ||
        this.bytes[start + 4] > 1)
    ) {
      fail(
        "The default coding style has an invalid progression, layer count or component transform."
      );
    }
    this.exact(segment, minimum + (flags & 1 ? levels + 1 : 0));
    if (flags & 1) {
      for (let index = 1; index <= levels; index++) {
        const precinct = this.bytes[data + 5 + index];
        if (!(precinct & 15) || !(precinct >> 4)) {
          fail("Non-LL precinct exponents must both be nonzero.");
        }
      }
    }
    return levels;
  }

  quantization(segment, levels, prefix = 0) {
    this.minimum(segment, 3 + prefix);
    const style = this.bytes[segment.data + prefix] & 31;
    if (style > 2) {
      fail("The quantization marker has an invalid quantization style.");
    }
    const subbands = 3 * levels + 1;
    let size = 2;
    if (style === 0) {
      size = subbands;
    } else if (style === 2) {
      size = 2 * subbands;
    }
    const available = segment.length - 3 - prefix;
    if (style === 1) {
      this.exact(segment, 3 + prefix + size);
    } else {
      const unit = style === 0 ? 1 : 2;
      const count = available / unit;
      if (
        !Number.isInteger(count) ||
        count < subbands ||
        count > 97 ||
        count % 3 !== 1
      ) {
        fail(
          "The quantization marker does not contain a complete supported subband entry set."
        );
      }
    }
    if (style === 0) {
      for (
        let offset = segment.data + prefix + 1;
        offset < segment.end;
        offset++
      ) {
        if (this.bytes[offset] & 7) {
          fail("An unquantized subband descriptor contains reserved low bits.");
        }
      }
    }
  }

  geometry(segment) {
    this.minimum(segment, 38);
    if (this.view.getUint16(segment.data) !== 0) {
      unknown(
        "JPEG 2000 profile or capability extensions are outside this base-profile inspection."
      );
    }
    const count = this.view.getUint16(segment.data + 34);
    this.exact(segment, 38 + 3 * count);
    if (!count) {
      fail("SIZ has no image components.");
    }
    const x = this.view.getUint32(segment.data + 2);
    const y = this.view.getUint32(segment.data + 6);
    const originX = this.view.getUint32(segment.data + 10);
    const originY = this.view.getUint32(segment.data + 14);
    const tileX = this.view.getUint32(segment.data + 18);
    const tileY = this.view.getUint32(segment.data + 22);
    const tileOriginX = this.view.getUint32(segment.data + 26);
    const tileOriginY = this.view.getUint32(segment.data + 30);
    if (
      x <= originX ||
      y <= originY ||
      !tileX ||
      !tileY ||
      tileOriginX > originX ||
      tileOriginY > originY ||
      tileOriginX + tileX <= originX ||
      tileOriginY + tileY <= originY
    ) {
      fail("SIZ declares an invalid image or tile grid.");
    }
    this.tileCount =
      Math.ceil((x - tileOriginX) / tileX) *
      Math.ceil((y - tileOriginY) / tileY);
    if (this.tileCount > 65535) {
      fail("SIZ declares more tiles than Part 1 tile indices can represent.");
    }
    if (this.tileCount > 4096 || count > 64) {
      unknown(
        "The image tile or component count exceeds the inspection limit."
      );
    }
    this.components = count;
  }

  header(offset, main, part = 0, limit = this.bytes.length) {
    const state = {
      cod: null,
      codFlags: null,
      qcd: null,
      coc: new Map(),
      qcc: new Map(),
      regions: new Set(),
    };
    let first = true;
    while (offset + 2 <= limit) {
      const marker = this.marker(offset);
      if ((main && marker === SOT) || (!main && marker === SOD)) {
        this.finishHeader(state, main, part);
        return { offset, state };
      }
      if (
        (main && first && marker !== SIZ) ||
        [SOC, SOT, SOD, EOC, 0xff91, 0xff92].includes(marker)
      ) {
        fail("A marker occurs in an invalid codestream header position.");
      }
      first = false;
      const known =
        [SIZ, COD, COC, QCD, QCC, RGN, COM].includes(marker) ||
        OPTIONAL.has(marker);
      if (!known) {
        unknown(
          "An extension or unknown marker prevents complete header inspection."
        );
      }
      const segment = this.segment(offset);
      if (segment.end > limit) {
        fail(
          "A marker segment exceeds its enclosing header or tile-part extent."
        );
      }
      if (
        (!main && MAIN_ONLY.has(marker)) ||
        (main && TILE_ONLY.has(marker)) ||
        (!main && part > 0 && !LATER_PART.has(marker))
      ) {
        fail("A marker is not permitted in this main or tile-part header.");
      }
      if (marker === SIZ) {
        if (!main || this.components !== undefined) {
          fail("SIZ must occur once immediately after SOC.");
        }
        this.geometry(segment);
      } else if (marker === COD) {
        if (state.cod !== null) {
          fail("A header contains multiple default coding style markers.");
        }
        state.cod = this.coding(segment);
        state.codFlags = this.bytes[segment.data];
      } else if (marker === COC) {
        const component = this.component(segment);
        if (state.coc.has(component.index)) {
          fail("A header contains duplicate component coding style markers.");
        }
        state.coc.set(component.index, this.coding(segment, true));
      } else if (marker === QCD) {
        if (state.qcd) {
          fail("A header contains multiple default quantization markers.");
        }
        state.qcd = segment;
      } else if (marker === QCC) {
        const component = this.component(segment);
        if (state.qcc.has(component.index)) {
          fail("A header contains duplicate component quantization markers.");
        }
        state.qcc.set(component.index, { segment, prefix: component.size });
      } else if (marker === RGN) {
        const component = this.component(segment);
        this.exact(segment, 4 + component.size);
        if (
          state.regions.has(component.index) ||
          this.bytes[segment.data + component.size] !== 0
        ) {
          fail(
            "A region-of-interest marker has invalid style or duplicate component."
          );
        }
        state.regions.add(component.index);
      } else if (marker === COM) {
        this.minimum(segment, 5);
        if (this.view.getUint16(segment.data) > 1) {
          this.pending =
            "An unregistered comment representation is outside this inspection.";
        }
      } else {
        this.minimum(segment, OPTIONAL.get(marker));
        if (marker === 0xff60) {
          this.packedMain = true;
        }
        if (marker === 0xff61) {
          this.packedTile = true;
        }
        this.pending =
          "Additional packet, progression or registration marker fields remain unverified.";
      }
      offset = segment.end;
    }
    return fail("A codestream header has no terminating tile-part marker.");
  }

  finishHeader(state, main, part) {
    if (main && (state.cod === null || !state.qcd)) {
      fail("The main codestream header requires COD and QCD markers.");
    }
    // Default markers may be entirely overridden. Check their independent
    // shape first, then check the quantization actually selected for each tile.
    if (state.qcd) {
      this.quantization(state.qcd, 0);
    }
    for (const quantization of state.qcc.values()) {
      this.quantization(quantization.segment, 0, quantization.prefix);
    }
    if (this.packedMain && this.packedTile) {
      fail(
        "Main-header and tile-header packed packet headers are mutually exclusive."
      );
    }
    if (main || part > 0) {
      return;
    }
    const selected = new Map();
    for (let index = 0; index < this.components; index++) {
      const inherited = state.cod === null ? this.main.coc.get(index) : null;
      const levels =
        state.coc.get(index) ?? state.cod ?? inherited ?? this.main.cod;
      let quantization = state.qcc.get(index);
      quantization ||= state.qcd
        ? { segment: state.qcd, prefix: 0 }
        : (this.main.qcc.get(index) ?? { segment: this.main.qcd, prefix: 0 });
      const previous = selected.get(quantization.segment);
      if (!previous || previous.levels < levels) {
        selected.set(quantization.segment, { ...quantization, levels });
      }
    }
    for (const quantization of selected.values()) {
      this.quantization(
        quantization.segment,
        quantization.levels,
        quantization.prefix
      );
    }
  }

  finalTilePart(offset, flags) {
    const end = this.bytes.length - 2;
    // T.800 C.3.4 reserves FF followed by a byte > 8F for markers.
    // Lower values are coded data, including bytes resembling header markers.
    // This establishes framing only, without interpreting packet boundaries.
    while (offset < this.bytes.length) {
      if (this.bytes[offset] !== 255) {
        offset++;
        continue;
      }
      if (offset + 1 >= this.bytes.length) {
        fail("The open-ended tile-part ends with an incomplete marker.");
      }
      const code = this.bytes[offset + 1];
      if (code <= 0x8f) {
        offset += 2;
        continue;
      }
      const marker = this.view.getUint16(offset);
      if (marker === EOC) {
        if (offset !== end) {
          fail("EOC occurs before the end of the open-ended final tile-part.");
        }
        return offset;
      }
      if (marker === SOT || marker === SOD) {
        fail(
          "An open-ended tile-part must be final and cannot contain SOT or SOD."
        );
      }
      if (code === 255) {
        unknown(
          "Consecutive FF bytes cannot establish a final marker boundary without interpreting truncated packet data."
        );
      }
      if (marker === SOP) {
        if (!(flags & 2)) {
          fail("SOP is not permitted by the effective tile coding style.");
        }
        if (offset + 6 > end || this.view.getUint16(offset + 2) !== 4) {
          fail("The open-ended tile-part has a truncated SOP or invalid Lsop.");
        }
        // Nsop is an opaque 16-bit value here. SOP need not occur on every
        // packet, so observed values need not be consecutive or start at zero.
        offset += 6;
        continue;
      }
      if (marker === EPH) {
        if (!(flags & 4)) {
          fail("EPH is not permitted by the effective tile coding style.");
        }
        offset += 2;
        continue;
      }
      unknown(
        "An extension or reserved marker prevents open-ended tile-part framing inspection."
      );
    }
    return fail("The open-ended tile-part has no terminating EOC marker.");
  }

  inspect() {
    const length = this.bytes.length;
    if (length < 4 || this.marker(0) !== SOC) {
      fail("The codestream must begin with SOC.");
    }
    if (this.view.getUint16(length - 2) !== EOC) {
      fail("The codestream must end with EOC.");
    }
    const initial = this.header(2, true);
    let offset = initial.offset;
    this.main = initial.state;
    while (offset < length) {
      const marker = this.marker(offset);
      if (marker === EOC) {
        if (
          offset !== length - 2 ||
          !this.counts.tileParts ||
          this.tiles.size !== this.tileCount
        ) {
          fail("EOC is misplaced or the codestream omits image tiles.");
        }
        for (const tile of this.tiles.values()) {
          if (tile.total && tile.next !== tile.total) {
            fail(
              "A tile's declared tile-part count does not match its observed parts."
            );
          }
        }
        this.counts.tiles = this.tiles.size;
        return {
          status: this.pending ? "unknown" : "pass",
          detail:
            this.pending ??
            "Main and tile-part marker fields, declared or scanned final boundaries and final EOC were checked without decoding packets.",
          counts: this.counts,
        };
      }
      if (marker !== SOT) {
        fail("A declared tile-part boundary is not followed by SOT or EOC.");
      }
      if (++this.counts.tileParts > 4096) {
        unknown("The tile-part count exceeds the inspection limit.");
      }
      const start = offset;
      const segment = this.segment(offset);
      this.exact(segment, 10);
      const index = this.view.getUint16(segment.data);
      const size = this.view.getUint32(segment.data + 2);
      const part = this.bytes[segment.data + 6],
        total = this.bytes[segment.data + 7];
      if (
        index >= this.tileCount ||
        index === 65535 ||
        part === 255 ||
        (size !== 0 && size < 14)
      ) {
        fail(
          "The start-of-tile-part marker has invalid index, count or extent."
        );
      }
      const tile = this.tiles.get(index) ?? { next: 0, total: 0 };
      if (
        part !== tile.next ||
        (total && part >= total) ||
        (total && tile.total && total !== tile.total)
      ) {
        fail("Tile-part indices or declared totals are inconsistent.");
      }
      tile.next++;
      tile.total ||= total;
      this.tiles.set(index, tile);
      const end = size ? start + size : length - 2;
      if (end > length - 2) {
        fail("A tile-part extent exceeds final EOC.");
      }
      const parsed = this.header(segment.end, false, part, end);
      offset = parsed.offset + 2;
      if (part === 0) {
        tile.flags = parsed.state.codFlags ?? this.main.codFlags;
      }
      if (size === 0) {
        this.counts.openEndedTileParts++;
        offset = this.finalTilePart(offset, tile.flags);
        continue;
      }
      if (end < offset || end > length - 2) {
        fail(
          "A tile-part extent does not contain its header or exceeds final EOC."
        );
      }
      offset = end;
    }
    return fail("The codestream has no final EOC marker.");
  }
}

function inspectJpxCodestream(bytes) {
  const wrapper = getJpxCodestream(bytes);
  if (wrapper.status !== "pass") {
    return { status: wrapper.status, detail: wrapper.detail };
  }
  const inspection = new CodestreamInspection(wrapper.bytes);
  try {
    return inspection.inspect();
  } catch (error) {
    if (error instanceof CodestreamFinding) {
      return {
        status: error.status,
        detail: error.message,
        counts: inspection.counts,
      };
    }
    return {
      status: "unknown",
      detail:
        "The original JPEG 2000 marker structure could not be fully inspected.",
      counts: inspection.counts,
    };
  }
}

export { inspectJpxCodestream };
