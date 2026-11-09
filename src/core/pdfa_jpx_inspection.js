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

const EXTENSIONS = new Set([
  "jplh",
  "jclx",
  "j2cx",
  "cref",
  "flst",
  "jpch",
  "opct",
  "pclr",
  "cmap",
  "comp",
  "rreq",
  "dtbl",
  "ftbl",
]);

class JpxFinding extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fail(detail) {
  throw new JpxFinding("fail", detail);
}

function unknown(detail) {
  throw new JpxFinding("unknown", detail);
}

class Jp2HeaderInspection {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.boxCount = 0;
  }

  word(offset) {
    return String.fromCharCode(...this.bytes.subarray(offset, offset + 4));
  }

  boxes(start, end, depth = 0) {
    if (depth > 8) {
      unknown("JPEG 2000 box nesting exceeds the inspection limit.");
    }
    const boxes = [];
    for (let offset = start; offset < end;) {
      if (++this.boxCount > 1024) {
        unknown("JPEG 2000 box count exceeds the inspection limit.");
      }
      if (end - offset < 8) {
        fail("A JPEG 2000 box header is truncated.");
      }
      let length = BigInt(this.view.getUint32(offset));
      let header = 8;
      if (length === 1n) {
        if (end - offset < 16) {
          fail("An extended JPEG 2000 box header is truncated.");
        }
        length = this.view.getBigUint64(offset + 8);
        header = 16;
      } else if (length === 0n) {
        if (depth > 0) {
          fail(
            "A zero-length box cannot be contained in the finite JP2 header."
          );
        }
        length = BigInt(end - offset);
      }
      if (length < BigInt(header) || length > BigInt(end - offset)) {
        fail("A JPEG 2000 box length exceeds its enclosing bytes.");
      }
      const next = offset + Number(length);
      boxes.push({
        type: this.word(offset + 4),
        offset,
        data: offset + header,
        end: next,
      });
      offset = next;
    }
    return boxes;
  }

  one(boxes, type, required = true) {
    const matches = boxes.filter(box => box.type === type);
    if (matches.length > 1 || (required && !matches.length)) {
      fail("The JPEG 2000 header has a missing or duplicate " + type + " box.");
    }
    return matches[0];
  }

  size(box, length) {
    if (box.end - box.data !== length) {
      fail("The " + box.type + " box has an invalid payload length.");
    }
  }

  supported(boxes) {
    if (boxes.some(box => EXTENSIONS.has(box.type))) {
      unknown(
        "JPX layers, palette mappings or extension boxes are outside this inspection."
      );
    }
  }

  color(boxes) {
    const colors = boxes.filter(box => box.type === "colr");
    if (!colors.length) {
      fail("The JP2 header has no colour specification box.");
    }
    if (colors.length > 32) {
      unknown("The colour specification count exceeds the inspection limit.");
    }
    let count = null;
    for (const box of colors) {
      if (box.end - box.data < 3) {
        fail("A colour specification box is truncated.");
      }
      const method = this.bytes[box.data];
      let components = null;
      if (method === 1) {
        this.size(box, 7);
        const enumeration = this.view.getUint32(box.data + 3);
        components = new Map([
          [16, 3],
          [17, 1],
          [18, 3],
          [12, 4],
        ]).get(enumeration);
      } else if (method === 2) {
        if (box.end - box.data < 3 + 128) {
          fail("The JP2 colour profile header is truncated.");
        }
        const profile = box.data + 3;
        if (this.word(profile + 36) !== "acsp") {
          unknown("The JP2 colour profile signature could not be established.");
        }
        components = new Map([
          ["GRAY", 1],
          ["RGB ", 3],
          ["CMYK", 4],
        ]).get(this.word(profile + 16));
      }
      if (!components || (count && count !== components)) {
        unknown(
          "The effective JPEG 2000 colour channel count is outside this inspection."
        );
      }
      count = components;
    }
    return count;
  }

  image(header, children, codestream) {
    const info = this.one(children, "ihdr");
    if (children[0] !== info) {
      fail("The image header must be the first box inside jp2h.");
    }
    this.size(info, 14);
    const height = this.view.getUint32(info.data);
    const width = this.view.getUint32(info.data + 4);
    const count = this.view.getUint16(info.data + 8);
    const precision = this.bytes[info.data + 10];
    if (!width || !height || !count || this.bytes[info.data + 11] !== 7) {
      fail(
        "The JP2 image dimensions, component count or compression type is invalid."
      );
    }
    if (count > 64) {
      unknown("The JPEG 2000 component count exceeds the inspection limit.");
    }
    const bpcc = this.one(children, "bpcc", precision === 255);
    let descriptors;
    if (precision === 255) {
      this.size(bpcc, count);
      descriptors = this.bytes.subarray(bpcc.data, bpcc.end);
    } else {
      if (bpcc) {
        unknown(
          "A per-component precision box with uniform ihdr precision is outside this inspection."
        );
      }
      descriptors = new Uint8Array(count).fill(precision);
    }
    if (Array.from(descriptors).some(value => (value & 127) >= 38)) {
      fail("The JPEG 2000 sample precision is outside 1 to 38 bits.");
    }
    if (codestream.offset < header.end) {
      fail("The codestream appears before the complete JP2 header.");
    }
    const start = codestream.data;
    const length = codestream.end - start;
    if (
      length < 42 ||
      this.view.getUint16(start) !== 0xff4f ||
      this.view.getUint16(start + 2) !== 0xff51
    ) {
      fail("The first codestream lacks its initial SOC and SIZ markers.");
    }
    const sizLength = this.view.getUint16(start + 4);
    const components = this.view.getUint16(start + 40);
    if (sizLength !== 38 + 3 * components || 4 + sizLength > length) {
      fail("The codestream SIZ marker has an invalid length.");
    }
    const x = this.view.getUint32(start + 8);
    const y = this.view.getUint32(start + 12);
    const xOrigin = this.view.getUint32(start + 16);
    const yOrigin = this.view.getUint32(start + 20);
    if (
      components !== count ||
      x <= xOrigin ||
      y <= yOrigin ||
      x - xOrigin !== width ||
      y - yOrigin !== height
    ) {
      fail(
        "The JP2 image header and codestream dimensions or components disagree."
      );
    }
    if (!this.view.getUint32(start + 24) || !this.view.getUint32(start + 28)) {
      fail("The codestream declares an empty tile grid.");
    }
    for (let i = 0; i < count; i++) {
      const field = start + 42 + 3 * i;
      if (
        this.bytes[field] !== descriptors[i] ||
        !this.bytes[field + 1] ||
        !this.bytes[field + 2]
      ) {
        fail(
          "The JP2 header and SIZ sample descriptors disagree or have invalid sampling."
        );
      }
    }
    return { count, descriptors };
  }

  alpha(box, image, colors) {
    if (!box) {
      if (image.count !== colors) {
        fail(
          "The JP2 image has auxiliary channels without a channel definition box."
        );
      }
      return null;
    }
    const length = box.end - box.data;
    if (length < 2) {
      fail("The channel definition box is truncated.");
    }
    const count = this.view.getUint16(box.data);
    if (!count || length !== 2 + 6 * count) {
      fail("The channel definition box has an invalid entry count or length.");
    }
    if (count > 256) {
      unknown("The channel definition count exceeds the inspection limit.");
    }

    const channelTypes = new Map(),
      associations = new Map();
    const ordinary = new Set(),
      alphaChannels = new Set(),
      alphaColors = new Set();
    let alphaType = null;
    for (let i = 0; i < count; i++) {
      const offset = box.data + 2 + 6 * i;
      const channel = this.view.getUint16(offset);
      const type = this.view.getUint16(offset + 2);
      const association = this.view.getUint16(offset + 4);
      if (channel >= image.count || ![0, 1, 2, 65535].includes(type)) {
        fail("A channel definition index or channel type is invalid.");
      }
      if (type === 65535 || association === 65535) {
        unknown(
          "An unspecified JPEG 2000 channel cannot establish alpha coverage."
        );
      }
      if (channelTypes.has(channel) && channelTypes.get(channel) !== type) {
        unknown(
          "Mixed roles for the same JPEG 2000 channel are outside this inspection."
        );
      }
      channelTypes.set(channel, type);
      const key = type + "/" + association;
      if (associations.has(key) && associations.get(key) !== channel) {
        fail("Different channels have the same type and colour association.");
      }
      associations.set(key, channel);
      if (association > colors) {
        fail(
          "A channel definition refers to a colour outside the declared colour space."
        );
      }
      if (type === 0) {
        if (!association) {
          unknown("The colour channel definitions are ambiguous.");
        }
        ordinary.add(association);
      } else {
        alphaChannels.add(channel);
        alphaColors.add(association);
        alphaType = type;
        if (image.descriptors[channel] & 128) {
          fail("JPEG 2000 opacity must use an unsigned sample component.");
        }
      }
    }
    if (alphaChannels.size > 1) {
      fail(
        "A PDF image with embedded alpha must have exactly one opacity channel."
      );
    }
    if (ordinary.size !== colors || channelTypes.size !== image.count) {
      unknown(
        "The channel definitions do not establish the complete direct component mapping."
      );
    }
    if (!alphaChannels.size) {
      return null;
    }
    if (
      !alphaColors.has(0) &&
      Array.from({ length: colors }, (_, i) => i + 1).some(
        association => !alphaColors.has(association)
      )
    ) {
      fail("The opacity channel does not cover all colour channels.");
    }
    return alphaType;
  }

  header() {
    const boxes = this.boxes(0, this.bytes.length);
    const signature = this.one(boxes, "jP  ");
    this.size(signature, 4);
    if (
      boxes[0] !== signature ||
      signature.data !== 8 ||
      signature.end !== 12 ||
      this.view.getUint32(signature.data) !== 0x0d0a870a
    ) {
      fail("The JP2 signature box is invalid.");
    }
    const fileType = this.one(boxes, "ftyp");
    if (
      boxes[1] !== fileType ||
      fileType.end - fileType.data < 12 ||
      (fileType.end - fileType.data) % 4
    ) {
      fail("The JP2 file type box has an invalid order or length.");
    }
    const brands = [];
    for (let offset = fileType.data; offset < fileType.end; offset += 4) {
      if (offset !== fileType.data + 4) {
        brands.push(this.word(offset));
      }
    }
    if (
      this.word(fileType.data) !== "jp2 " ||
      !brands.includes("jp2 ") ||
      brands.some(brand => brand !== "jp2 ")
    ) {
      unknown(
        "JPX brands or other file type extensions are outside this inspection."
      );
    }
    this.supported(boxes);
    const header = this.one(boxes, "jp2h");
    const children = this.boxes(header.data, header.end, 1);
    this.supported(children);
    const codestreams = boxes.filter(box => box.type === "jp2c");
    if (!codestreams.length) {
      fail("The JP2 file contains no codestream box.");
    }
    const image = this.image(header, children, codestreams[0]);
    return { children, image, codestream: codestreams[0] };
  }

  inspect(mode) {
    const { children, image } = this.header();
    const colors = this.color(children);
    if (mode === 0) {
      return {
        status: "pass",
        transparent: false,
        detail: "Embedded opacity is ignored by the declared zero alpha mode.",
      };
    }
    const type = this.alpha(this.one(children, "cdef", false), image, colors);
    if (type === null) {
      return {
        status: "fail",
        transparent: false,
        detail:
          "The supported JP2 header declares no opacity channel for the requested embedded alpha.",
      };
    }
    if (type !== mode) {
      unknown(
        "The embedded opacity type and PDF alpha mode require interpretation outside this inspection."
      );
    }
    return {
      status: "pass",
      transparent: true,
      detail:
        "The original JP2 channel definitions establish one unsigned opacity channel covering all colour channels.",
    };
  }
}

function headerInspection(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 4 * 1024 * 1024) {
    unknown("The original JPEG 2000 bytes exceed the supported input limit.");
  }
  if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 79) {
    unknown(
      "A raw JPEG 2000 codestream is outside the supported JP2 wrapper inspection."
    );
  }
  return new Jp2HeaderInspection(bytes);
}

function getJpxCodestream(bytes) {
  try {
    const { codestream } = headerInspection(bytes).header();
    return {
      status: "pass",
      detail: "The first original JP2 codestream is bounded by its container.",
      bytes: bytes.subarray(codestream.data, codestream.end),
    };
  } catch (error) {
    return {
      status: error instanceof JpxFinding ? error.status : "unknown",
      detail:
        error instanceof JpxFinding
          ? error.message
          : "The original JP2 codestream boundaries could not be established.",
    };
  }
}

function inspectJpxAlpha(bytes, mode) {
  try {
    if (![0, 1, 2].includes(mode)) {
      unknown("The embedded alpha mode could not be established.");
    }
    return headerInspection(bytes).inspect(mode);
  } catch (error) {
    if (error instanceof JpxFinding) {
      return { status: error.status, detail: error.message, transparent: null };
    }
    return {
      status: "unknown",
      detail: "The original JP2 alpha metadata could not be fully inspected.",
      transparent: null,
    };
  }
}

export { getJpxCodestream, inspectJpxAlpha };
