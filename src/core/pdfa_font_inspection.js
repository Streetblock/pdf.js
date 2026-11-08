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

import {
  CIRCULAR_REF,
  Cmd,
  Dict,
  EOF,
  isName,
  Name,
  Ref,
} from "./primitives.js";
import { Lexer, Parser } from "./parser.js";
import { BaseStream } from "./base_stream.js";
import { EvaluatorPreprocessor } from "./evaluator.js";
import { FlateStream } from "./flate_stream.js";
import { getEncoding } from "./encodings.js";
import { MissingDataException } from "./core_utils.js";
import { readFlate } from "./pdfa_xref_inspection.js";
import { Stream } from "./stream.js";

const EMBEDDED = "6.2.11.4.1-1";
const GLYPH = "6.2.11.4.1-2";
const NOTDEF = "6.2.11.8-1";
const RULES = [EMBEDDED, GLYPH, NOTDEF];
const UNKNOWN = Symbol("unknown");
const RANK = { "not-applicable": 0, pass: 1, unknown: 2, fail: 3 };
const MAX_DEPTH = 32;
const MAX_VISITS = 8192;
const MAX_OPERATORS = 200_000;
const MAX_GLYPHS = 500_000;
const MAX_BYTES = 4 * 1024 * 1024;
const TOTAL_BYTES = 16 * 1024 * 1024;
const FONT_KEYS = ["FontFile", "FontFile2", "FontFile3"];

function absent(value) {
  return value === null || value === undefined;
}

function sfntSignature(bytes) {
  return (
    (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) ||
    (bytes[0] === 0x74 &&
      bytes[1] === 0x72 &&
      bytes[2] === 0x75 &&
      bytes[3] === 0x65)
  );
}

// Check the original TrueType table directory and glyph index. Empty glyph
// ranges are permitted (e.g. space). No renderer-repaired sfnt is consulted.
function trueTypeGlyphCount(bytes) {
  if (bytes.length < 12 || !sfntSignature(bytes)) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tableCount = view.getUint16(4);
  if (!tableCount || tableCount > 256 || 12 + tableCount * 16 > bytes.length) {
    return null;
  }
  const tables = new Map();
  for (let i = 0; i < tableCount; i++) {
    const offset = 12 + i * 16;
    const tag = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const start = view.getUint32(offset + 8);
    const length = view.getUint32(offset + 12);
    if (start + length > bytes.length || tables.has(tag)) {
      return null;
    }
    tables.set(tag, { start, length });
  }
  const head = tables.get("head"),
    maxp = tables.get("maxp"),
    loca = tables.get("loca"),
    glyf = tables.get("glyf");
  if (!head || head.length < 54 || !maxp || maxp.length < 6 || !loca || !glyf) {
    return null;
  }
  const count = view.getUint16(maxp.start + 4);
  const format = view.getInt16(head.start + 50);
  const size = format === 0 ? 2 : 4;
  if (
    !count ||
    (format !== 0 && format !== 1) ||
    loca.length < (count + 1) * size
  ) {
    return null;
  }
  let previous = 0;
  for (let i = 0; i <= count; i++) {
    const offset = loca.start + i * size;
    const next =
      format === 0 ? 2 * view.getUint16(offset) : view.getUint32(offset);
    if (
      next < previous ||
      next > glyf.length ||
      (next !== previous && next - previous < 10)
    ) {
      return null;
    }
    previous = next;
  }
  return count;
}

class PdfAFontInspection {
  constructor(xref) {
    this.xref = xref;
    this.checks = new Map();
    this.pageNodes = new Set();
    this.activeStreams = new Set();
    this.streams = new Map();
    this.fonts = new Map();
    this.bytesRemaining = TOTAL_BYTES;
    this.visits = 0;
    this.operators = 0;
    this.counts = { pages: 0, streams: 0, fonts: 0, glyphs: 0 };
  }

  note(id, status, location, detail) {
    if (RANK[status] > (RANK[this.checks.get(id)?.status] ?? -1)) {
      this.checks.set(id, { id, status, location, detail });
    }
  }

  unknown(path, detail, ids = RULES) {
    for (const id of ids) {
      this.note(id, "unknown", path, detail);
    }
  }

  take(path, depth) {
    if (depth <= MAX_DEPTH && this.visits < MAX_VISITS) {
      this.visits++;
      return true;
    }
    this.unknown(path, "Font inspection reached its traversal limit.");
    return false;
  }

  resolve(raw) {
    if (!(raw instanceof Ref)) {
      return raw === CIRCULAR_REF ? UNKNOWN : raw;
    }
    try {
      const entry = this.xref.getEntry(raw.num);
      if (!entry || (entry.uncompressed ? entry.gen : 0) !== raw.gen) {
        return UNKNOWN;
      }
      const value = this.xref.fetch(raw);
      return absent(value) || value === CIRCULAR_REF ? UNKNOWN : value;
    } catch (error) {
      if (error instanceof MissingDataException) {
        throw error;
      }
      return UNKNOWN;
    }
  }

  field(dict, key) {
    return this.resolve(dict.getRaw(key));
  }

  async bytes(stream) {
    if (
      !(stream instanceof BaseStream) ||
      !absent(this.field(stream.dict, "F"))
    ) {
      return null;
    }
    if (this.streams.has(stream)) {
      return this.streams.get(stream);
    }
    let result = null;
    const limit = Math.min(MAX_BYTES, this.bytesRemaining);
    const source = stream instanceof FlateStream ? stream.stream : stream;
    if (limit > 0 && source instanceof Stream && source.length <= MAX_BYTES) {
      try {
        if (stream instanceof FlateStream) {
          if (typeof DecompressionStream === "function") {
            result = await readFlate(
              source.getByteRange(source.start, source.end),
              limit
            );
          }
        } else if (source.length <= limit) {
          result = source.getByteRange(source.start, source.end);
        }
      } catch (error) {
        if (error instanceof MissingDataException) {
          throw error;
        }
      }
    }
    if (result) {
      this.bytesRemaining -= result.length;
      this.counts.streams++;
    }
    this.streams.set(stream, result);
    return result;
  }

  fontResource(resources, group, name) {
    if (!(resources instanceof Dict) || !(name instanceof Name)) {
      return UNKNOWN;
    }
    const dictionary = this.field(resources, group);
    return dictionary instanceof Dict
      ? this.field(dictionary, name.name)
      : UNKNOWN;
  }

  async page(raw, inherited, path, depth) {
    if (!this.take(path, depth)) {
      return;
    }
    const node = this.resolve(raw);
    if (!(node instanceof Dict) || this.pageNodes.has(node)) {
      this.unknown(path, "The page tree is incomplete or cyclic.");
      return;
    }
    this.pageNodes.add(node);
    const resourceEntry = node.getRaw("Resources");
    const resources = absent(resourceEntry)
      ? inherited
      : this.resolve(resourceEntry);
    const type = this.field(node, "Type");
    if (isName(type, "Pages")) {
      const kids = this.field(node, "Kids");
      if (!Array.isArray(kids)) {
        this.unknown(path, "The page-tree child list is unreadable.");
        return;
      }
      for (let i = 0; i < kids.length; i++) {
        if (this.visits >= MAX_VISITS) {
          this.unknown(path, "The remaining pages were not inspected.");
          return;
        }
        await this.page(
          kids[i],
          resources,
          path + "/Kids[" + i + "]",
          depth + 1
        );
      }
      return;
    }
    if (!isName(type, "Page")) {
      this.unknown(
        path,
        "The page-tree node type is unreadable or unsupported."
      );
      return;
    }
    this.counts.pages++;
    const pagePath = "/Page[" + this.counts.pages + "]";
    const annotations = this.field(node, "Annots");
    if (!absent(annotations)) {
      if (
        !Array.isArray(annotations) ||
        annotations.length > MAX_VISITS ||
        annotations.some(rawAnnotation => {
          const annotation = this.resolve(rawAnnotation);
          return (
            !(annotation instanceof Dict) ||
            !absent(annotation.getRaw("AP")) ||
            isName(this.field(annotation, "Subtype"), "Widget") ||
            isName(this.field(annotation, "Subtype"), "FreeText")
          );
        })
      ) {
        this.unknown(
          pagePath + "/Annots",
          "Fonts in annotation appearances are outside this inspection."
        );
      }
    }
    const contents = this.field(node, "Contents");
    if (absent(contents)) {
      return;
    }
    const streams = Array.isArray(contents) ? contents : [contents];
    if (streams.length > MAX_VISITS) {
      this.unknown(pagePath + "/Contents", "Too many page content streams.");
      return;
    }
    const parts = [];
    let length = 0;
    for (const stream of streams) {
      const part = await this.bytes(this.resolve(stream));
      if (!part || length + part.length > MAX_BYTES) {
        this.unknown(
          pagePath + "/Contents",
          "The complete page content could not be read."
        );
        return;
      }
      parts.push(part);
      length += part.length;
    }
    // The graphics state and token stream are shared by all parts of a page.
    const bytes = parts.length === 1 ? parts[0] : new Uint8Array(length);
    if (parts.length > 1) {
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
    }
    await this.content(
      bytes,
      resources,
      { font: null, mode: 0, pageResources: resources },
      pagePath + "/Contents",
      0
    );
  }

  async nestedContent(stream, resources, state, path, depth) {
    if (!this.take(path, depth) || this.activeStreams.has(stream)) {
      this.unknown(
        path,
        "A cyclic or limited content stream was not inspected."
      );
      return;
    }
    const bytes = await this.bytes(stream);
    if (!bytes) {
      this.unknown(path, "An invoked content stream could not be read.");
      return;
    }
    this.activeStreams.add(stream);
    try {
      await this.content(bytes, resources, { ...state }, path, depth);
    } finally {
      this.activeStreams.delete(stream);
    }
  }

  async content(bytes, resources, state, path, depth) {
    if (!bytes.length) {
      return;
    }
    const stack = [];
    const args = [];
    let inText = false;
    try {
      // Use the PDF lexer, not renderer operator lists: font fallback and
      // preprocessor recovery can conceal malformed or missing source data.
      const parser = new Parser({
        lexer: new Lexer(new Stream(bytes)),
        xref: null,
      });
      while (parser.buf1 !== EOF) {
        if (++this.operators > MAX_OPERATORS) {
          this.unknown(path, "The content operation limit was exceeded.");
          return;
        }
        // Inline-image terminators require a separate boundary audit.
        if (parser.buf1 instanceof Cmd && parser.buf1.cmd === "BI") {
          this.unknown(
            path,
            "The content after an inline image was not inspected."
          );
          return;
        }
        const token = parser.getObj();
        if (!(token instanceof Cmd)) {
          if (token instanceof Ref || args.length >= 33) {
            throw new Error("Invalid content operands");
          }
          args.push(token);
          continue;
        }
        const op = token.cmd;
        const spec = EvaluatorPreprocessor.opMap[op];
        if (
          !spec ||
          (spec.variableArgs
            ? args.length > spec.numArgs
            : args.length !== spec.numArgs)
        ) {
          throw new Error("Unknown or invalid content operation");
        }
        switch (op) {
          case "q":
            if (stack.length >= MAX_DEPTH) {
              throw new Error("Graphics stack limit");
            }
            stack.push({ ...state });
            break;
          case "Q":
            if (!stack.length) {
              throw new Error("Invalid graphics state");
            }
            state = stack.pop();
            break;
          case "BT":
          case "ET":
            if (inText === (op === "BT")) {
              throw new Error("Invalid text boundary");
            }
            inText = op === "BT";
            break;
          case "Tf":
            state.font =
              args[0] instanceof Name && Number.isFinite(args[1])
                ? this.fontResource(resources, "Font", args[0])
                : UNKNOWN;
            break;
          case "Tr":
            state.mode =
              Number.isInteger(args[0]) && args[0] >= 0 && args[0] <= 7
                ? args[0]
                : UNKNOWN;
            break;
          case "gs": {
            const gs = this.fontResource(resources, "ExtGState", args[0]);
            if (!(gs instanceof Dict)) {
              state.font = UNKNOWN;
              this.unknown(
                path + "/gs",
                "An external graphics state may introduce an uninspected font or soft mask."
              );
              break;
            }
            const selection = this.field(gs, "Font");
            if (!absent(selection)) {
              state.font =
                Array.isArray(selection) &&
                selection.length === 2 &&
                Number.isFinite(selection[1])
                  ? this.resolve(selection[0])
                  : UNKNOWN;
            }
            const mask = this.field(gs, "SMask");
            if (!absent(mask) && !isName(mask, "None")) {
              this.unknown(
                path + "/gs",
                "Font use in a soft mask is outside this inspection."
              );
            }
            break;
          }
          case "Do": {
            const xobject = this.fontResource(resources, "XObject", args[0]);
            const subtype =
              xobject instanceof BaseStream &&
              this.field(xobject.dict, "Subtype");
            if (isName(subtype, "Form") && absent(xobject.dict.getRaw("Ref"))) {
              const entry = xobject.dict.getRaw("Resources");
              const formResources = absent(entry)
                ? state.pageResources
                : this.resolve(entry);
              await this.nestedContent(
                xobject,
                formResources,
                state,
                path + "/Do",
                depth + 1
              );
            } else if (!isName(subtype, "Image")) {
              this.unknown(
                path + "/Do",
                "An invoked XObject could not be inspected for font use."
              );
            }
            break;
          }
          case "SCN":
          case "scn":
            if (args.at(-1) instanceof Name) {
              this.unknown(
                path + "/Pattern",
                "Font use in a tiling pattern is outside this inspection."
              );
            }
            break;
          case "Tj":
          case "TJ":
          case "'":
          case '"': {
            const text = args.at(-1);
            const strings =
              op === "TJ" && Array.isArray(text)
                ? text.filter(item => typeof item === "string")
                : [text];
            if (
              !inText ||
              (op === "TJ" &&
                (!Array.isArray(text) ||
                  text.some(
                    item => typeof item !== "string" && !Number.isFinite(item)
                  ))) ||
              strings.some(item => typeof item !== "string")
            ) {
              throw new Error("Invalid text showing operation");
            }
            if (strings.some(item => item.length > 0)) {
              await this.show(strings, state, path + "/" + op, depth);
            }
            break;
          }
        }
        args.length = 0;
      }
      if (args.length || inText || stack.length) {
        this.unknown(
          path,
          "The content stream has unfinished text or graphics state."
        );
      }
    } catch (error) {
      if (error instanceof MissingDataException) {
        throw error;
      }
      this.unknown(
        path,
        "A content stream could not be fully parsed for font use."
      );
    }
  }

  encoding(font) {
    const value = this.field(font, "Encoding");
    const base =
      value instanceof Dict ? this.field(value, "BaseEncoding") : value;
    const names =
      base instanceof Name ? getEncoding(base.name)?.slice() || [] : [];
    if (!(value instanceof Dict)) {
      return names;
    }
    const differences = this.field(value, "Differences");
    if (absent(differences)) {
      return names;
    }
    if (!Array.isArray(differences) || differences.length > 1024) {
      return [];
    }
    let code = -1;
    for (const raw of differences) {
      const entry = this.resolve(raw);
      if (Number.isInteger(entry) && entry >= 0 && entry <= 255) {
        code = entry;
      } else if (entry instanceof Name && code >= 0 && code <= 255) {
        names[code++] = entry.name;
      } else {
        return [];
      }
    }
    return names;
  }

  async fontInfo(font) {
    const type = this.field(font, "Subtype");
    let target = font,
      identity = false,
      cidMap = UNKNOWN,
      names = null;
    if (isName(type, "Type0")) {
      const descendants = this.field(font, "DescendantFonts");
      target =
        Array.isArray(descendants) && descendants.length === 1
          ? this.resolve(descendants[0])
          : UNKNOWN;
      const encoding = this.field(font, "Encoding");
      identity =
        isName(encoding, "Identity-H") || isName(encoding, "Identity-V");
      if (
        identity &&
        target instanceof Dict &&
        isName(this.field(target, "Subtype"), "CIDFontType2")
      ) {
        const map = this.field(target, "CIDToGIDMap");
        if (absent(map) || isName(map, "Identity")) {
          cidMap = null;
        } else if (map instanceof BaseStream) {
          const bytes = await this.bytes(map);
          if (bytes?.length && bytes.length % 2 === 0) {
            cidMap = new DataView(
              bytes.buffer,
              bytes.byteOffset,
              bytes.byteLength
            );
          }
        }
      }
    } else {
      names = this.encoding(font);
    }
    return { type, target, identity, cidMap, names, program: null };
  }

  async embedded(info) {
    if (info.program) {
      return info.program;
    }
    let status = "unknown";
    let glyphCount = null;
    if (!(info.target instanceof Dict)) {
      return (info.program = { status, glyphCount });
    }
    const subtype = this.field(info.target, "Subtype");
    const descriptor = this.field(info.target, "FontDescriptor");
    if (absent(descriptor)) {
      status = "fail";
    } else if (descriptor instanceof Dict) {
      const sources = FONT_KEYS.filter(key => !absent(descriptor.getRaw(key)));
      if (!sources.length) {
        status = "fail";
      } else if (sources.length === 1) {
        const key = sources[0];
        const stream = this.field(descriptor, key);
        if (stream instanceof BaseStream) {
          const external = this.field(stream.dict, "F");
          if (external !== UNKNOWN && !absent(external)) {
            status = "fail";
          } else {
            const bytes = await this.bytes(stream);
            if (bytes && !bytes.length) {
              status = "fail";
            } else if (bytes) {
              const sfnt = sfntSignature(bytes);
              const openTypeCff =
                bytes.length >= 12 &&
                bytes[0] === 0x4f &&
                bytes[1] === 0x54 &&
                bytes[2] === 0x54 &&
                bytes[3] === 0x4f;
              const type1 =
                isName(subtype, "Type1") || isName(subtype, "MMType1");
              const trueType =
                isName(subtype, "TrueType") || isName(subtype, "CIDFontType2");
              const cidType0 = isName(subtype, "CIDFontType0");
              let programPresent = false;
              if (key === "FontFile" && type1) {
                programPresent =
                  bytes.length > 4 &&
                  ((bytes[0] === 0x25 && bytes[1] === 0x21) ||
                    (bytes[0] === 0x80 && bytes[1] === 0x01));
              } else if (key === "FontFile2" && trueType && sfnt) {
                glyphCount = trueTypeGlyphCount(bytes);
                programPresent = glyphCount !== null;
              } else if (key === "FontFile3") {
                const format = this.field(stream.dict, "Subtype");
                if (isName(format, "OpenType")) {
                  if (trueType && sfnt) {
                    glyphCount = trueTypeGlyphCount(bytes);
                    programPresent = glyphCount !== null;
                  } else if ((type1 || cidType0) && openTypeCff) {
                    programPresent = true;
                  }
                } else if (
                  (type1 && isName(format, "Type1C")) ||
                  (cidType0 && isName(format, "CIDFontType0C"))
                ) {
                  programPresent =
                    bytes.length >= 4 &&
                    bytes[0] === 1 &&
                    bytes[2] >= 4 &&
                    bytes[2] <= bytes.length;
                }
              }
              if (programPresent) {
                status = "pass";
              }
            }
          }
        } else if (stream !== UNKNOWN) {
          status = "fail";
        }
      }
    }
    return (info.program = { status, glyphCount });
  }

  showCid(code, info, program, path) {
    const { cidMap } = info;
    let gid = null;
    if (cidMap === null) {
      gid = code;
    } else if (cidMap !== UNKNOWN && code * 2 < cidMap.byteLength) {
      gid = cidMap.getUint16(code * 2);
    }
    if (gid === null) {
      this.unknown(
        path,
        "No usable original CID-to-glyph mapping was available.",
        [NOTDEF]
      );
    } else {
      this.note(
        NOTDEF,
        gid === 0 ? "fail" : "pass",
        path,
        gid === 0
          ? "The shown character maps to TrueType glyph zero (.notdef)."
          : "The original CID mapping avoids glyph zero."
      );
    }
    if (program?.status !== "pass") {
      return;
    }
    if (gid === null || program.glyphCount === null) {
      this.unknown(
        path,
        "The original font program or CID-to-glyph mapping could not establish glyph presence.",
        [GLYPH]
      );
    } else {
      const present = gid < program.glyphCount;
      this.note(
        GLYPH,
        present ? "pass" : "fail",
        path,
        present
          ? "The original TrueType program defines the mapped glyph."
          : "The mapped glyph is absent in the original TrueType program."
      );
    }
  }

  async showType3(name, font, state, path, depth) {
    const procedures = this.field(font, "CharProcs");
    if (!(procedures instanceof Dict)) {
      this.note(
        EMBEDDED,
        procedures === UNKNOWN ? "unknown" : "fail",
        path,
        "The Type 3 font's glyph-procedure dictionary is missing or unreadable."
      );
      this.unknown(path, "No glyph procedure can be verified.", [GLYPH]);
      return;
    }
    this.note(
      EMBEDDED,
      "pass",
      path,
      "The Type 3 font uses PDF glyph procedures."
    );
    const procedure = name ? this.field(procedures, name) : UNKNOWN;
    if (procedure === UNKNOWN) {
      this.unknown(path, "The Type 3 glyph could not be resolved.", [GLYPH]);
      return;
    }
    if (!(procedure instanceof BaseStream)) {
      this.note(
        GLYPH,
        "fail",
        path,
        "The shown Type 3 glyph is missing from /CharProcs."
      );
      return;
    }
    const bytes = await this.bytes(procedure);
    if (!bytes?.length) {
      this.unknown(path, "The Type 3 glyph procedure could not be read.", [
        GLYPH,
      ]);
      return;
    }
    this.note(
      GLYPH,
      "pass",
      path,
      "The Type 3 font defines the named glyph in /CharProcs."
    );
    const entry = font.getRaw("Resources");
    const glyphResources = absent(entry)
      ? state.pageResources
      : this.resolve(entry);
    await this.nestedContent(
      procedure,
      glyphResources,
      state,
      path + "/CharProcs",
      depth + 1
    );
  }

  async show(strings, state, path, depth) {
    const { font, mode } = state;
    const relevant = mode === 3 ? [NOTDEF] : RULES;
    if (!(font instanceof Dict)) {
      this.unknown(
        path,
        "The font selected for shown text could not be resolved.",
        relevant
      );
      return;
    }
    if (!this.fonts.has(font)) {
      this.fonts.set(font, await this.fontInfo(font));
      this.counts.fonts++;
    }
    const info = this.fonts.get(font);
    const type3 = isName(info.type, "Type3");
    const composite = isName(info.type, "Type0");
    const visible = mode !== 3 && mode !== UNKNOWN;
    let program = null;
    if (mode === UNKNOWN) {
      this.unknown(path, "The text rendering mode could not be established.", [
        EMBEDDED,
        GLYPH,
      ]);
    } else if (visible && !type3) {
      program = await this.embedded(info);
      this.note(
        EMBEDDED,
        program.status,
        path,
        {
          pass: "An original font program stream is embedded.",
          fail: "A font used for rendering has no original embedded font program.",
          unknown: "The original font program could not be verified.",
        }[program.status]
      );
      if (program.status === "unknown") {
        this.unknown(
          path,
          "The original program could not be checked for used glyphs.",
          [GLYPH]
        );
      }
    }
    if (!(info.type instanceof Name) || (composite && !info.identity)) {
      this.unknown(
        path,
        "This font's original character mapping is not supported.",
        visible ? [GLYPH, NOTDEF] : [NOTDEF]
      );
      return;
    }
    const width = composite ? 2 : 1;
    for (const text of strings) {
      if (text.length % width !== 0) {
        this.unknown(
          path,
          "The shown text ends inside a character code.",
          relevant
        );
        continue;
      }
      for (let i = 0; i < text.length; i += width) {
        if (this.counts.glyphs >= MAX_GLYPHS) {
          this.unknown(
            path,
            "The number of inspected character codes was limited.",
            relevant
          );
          return;
        }
        this.counts.glyphs++;
        const code =
          width === 1
            ? text.charCodeAt(i)
            : 256 * text.charCodeAt(i) + text.charCodeAt(i + 1);
        if (composite) {
          this.showCid(code, info, program, path);
          continue;
        }
        const name = info.names?.[code];
        if (name === ".notdef") {
          this.note(
            NOTDEF,
            "fail",
            path,
            "The shown character explicitly references .notdef."
          );
        } else if (type3 && name) {
          this.note(
            NOTDEF,
            "pass",
            path,
            "The Type 3 encoding selects a named glyph."
          );
        } else {
          this.unknown(
            path,
            "The original simple font mapping was not fully verified.",
            [NOTDEF]
          );
        }
        if (visible && type3) {
          await this.showType3(name, font, state, path, depth);
        } else if (program?.status === "pass") {
          this.unknown(
            path,
            "Original glyph validation for this simple font format or encoding is outside this inspection.",
            [GLYPH]
          );
        }
      }
    }
  }

  finish() {
    return {
      checks: RULES.map(
        id =>
          this.checks.get(id) || {
            id,
            status: "not-applicable",
            location: "",
            detail: "No applicable shown text in the inspected content.",
          }
      ),
      counts: this.counts,
    };
  }
}

async function inspectPdfAFonts(xref, trusted) {
  const inspection = new PdfAFontInspection(xref);
  if (!trusted || xref.encrypt) {
    inspection.unknown(
      "/Root",
      "The effective font-use graph could not be verified."
    );
    return inspection.finish();
  }
  const root = inspection.field(xref.trailer, "Root");
  if (root instanceof Dict) {
    await inspection.page(root.getRaw("Pages"), null, "/Root/Pages", 0);
  } else {
    inspection.unknown("/Root", "The document catalog could not be resolved.");
  }
  return inspection.finish();
}

export { inspectPdfAFonts };
