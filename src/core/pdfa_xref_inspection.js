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

import { Cmd, Dict, EOF, isCmd, isName, Ref } from "./primitives.js";
import { Lexer, Parser } from "./parser.js";
import { bytesToString } from "../shared/util.js";
import { PredictorStream } from "./predictor_stream.js";
import { Stream } from "./stream.js";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_DECODED_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_DECODED_BYTES = 8 * 1024 * 1024;
const MAX_DICTIONARY_BYTES = 64 * 1024;
const MAX_SECTIONS = 128;
const MAX_ENTRIES = 100_000;
const MAX_OBJECT_STREAMS = 512;
const IDS = [
  "6.1.4-2",
  "PDF-XREF-TARGET",
  "PDF-XREF-TABLE",
  "PDF-XREF-STREAM",
  "PDF-XREF-ENTRY",
  "PDF-XREF-PREV",
  "PDF-OBJECT-STREAM",
];
const RANK = { "not-applicable": 0, pass: 1, unknown: 2, fail: 3 };

function isWhite(byte) {
  return (
    byte === 0 ||
    byte === 9 ||
    byte === 10 ||
    byte === 12 ||
    byte === 13 ||
    byte === 32
  );
}

function eolSize(bytes, offset) {
  if (bytes[offset] === 13) {
    return bytes[offset + 1] === 10 ? 2 : 1;
  }
  return bytes[offset] === 10 ? 1 : 0;
}

function isDelimiter(byte) {
  return isWhite(byte) || "()<>[]{}/%".includes(String.fromCharCode(byte));
}

function hasToken(bytes, offset, token) {
  return (
    offset >= 0 &&
    offset + token.length <= bytes.length &&
    bytesToString(bytes.subarray(offset, offset + token.length)) === token &&
    (offset + token.length === bytes.length ||
      isDelimiter(bytes[offset + token.length]))
  );
}

function skipWhite(bytes, offset, limit) {
  while (offset < limit) {
    if (isWhite(bytes[offset])) {
      offset++;
    } else if (bytes[offset] === 37) {
      while (offset < limit && !eolSize(bytes, offset)) {
        offset++;
      }
    } else {
      break;
    }
  }
  return offset;
}

function objectHeader(bytes, offset) {
  if (
    offset < 0 ||
    offset >= bytes.length ||
    (bytes[offset] !== 43 && (bytes[offset] < 48 || bytes[offset] > 57))
  ) {
    return null;
  }
  const end = Math.min(bytes.length, offset + 256);
  const lexer = new Lexer(new Stream(bytes, offset, end - offset));
  try {
    const number = lexer.getObj();
    const generation = lexer.getObj();
    if (
      Number.isSafeInteger(number) &&
      number > 0 &&
      Number.isInteger(generation) &&
      generation >= 0 &&
      generation <= 65535 &&
      isCmd(lexer.getObj(), "obj") &&
      lexer.currentChar !== -1
    ) {
      return { number, generation, end: lexer.stream.pos - 1 };
    }
  } catch {
    // No safely recognizable header at the supplied offset.
  }
  return end < bytes.length && lexer.stream.pos === end
    ? { limited: true }
    : null;
}

function parseDictionary(bytes, offset) {
  const end = Math.min(bytes.length, offset + MAX_DICTIONARY_BYTES);
  const start = skipWhite(bytes, offset, end);
  if (start + 1 >= end || bytes[start] !== 60 || bytes[start + 1] !== 60) {
    return null;
  }
  try {
    const lexer = new Lexer(new Stream(bytes, start, end - start));
    const parser = new Parser({ lexer, xref: null });
    const dict = parser.getObj();
    return dict instanceof Dict
      ? {
          dict,
          streamOffset: isCmd(parser.buf2, "stream")
            ? lexer.stream.pos - 1
            : null,
        }
      : null;
  } catch {
    return null;
  }
}

async function readFlate(data, limit) {
  const reader = new Blob([data])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"))
    .getReader();
  try {
    const chunks = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  } finally {
    reader.releaseLock();
  }
}

class PdfAXRefInspection {
  constructor(bytes, encrypted) {
    this.bytes = bytes;
    this.encrypted = encrypted;
    this.checks = new Map();
    this.counts = {
      revisions: 0,
      tables: 0,
      streams: 0,
      objectStreams: 0,
      entries: 0,
    };
    this.decodedRemaining = MAX_TOTAL_DECODED_BYTES;
  }

  note(id, status, offset, detail) {
    const previous = this.checks.get(id);
    if (!previous || RANK[status] > RANK[previous.status]) {
      this.checks.set(id, {
        id,
        status,
        location: (offset ?? null) === null ? "" : `Byte ${offset}`,
        detail,
      });
    }
  }

  unknownAll(detail) {
    for (const id of IDS) {
      this.note(id, "unknown", null, detail);
    }
  }

  finish() {
    return {
      checks: IDS.map(
        id =>
          this.checks.get(id) || {
            id,
            status: "not-applicable",
            location: "",
            detail: "No applicable structure in the inspected revision chain.",
          }
      ),
      counts: this.counts,
    };
  }

  acceptEntries(count, id, offset) {
    if (this.counts.entries + count > MAX_ENTRIES) {
      this.note(id, "unknown", offset, "Cross-reference entry limit exceeded.");
      return false;
    }
    this.counts.entries += count;
    return true;
  }

  async decode(dict, streamOffset) {
    const { bytes } = this;
    const length = dict.getRaw("Length");
    const eol = eolSize(bytes, streamOffset);
    const start = streamOffset + eol;
    if (
      !eol ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      start + length > bytes.length
    ) {
      return null;
    }
    const end = start + length;
    if (!hasToken(bytes, end + eolSize(bytes, end), "endstream")) {
      return null;
    }
    const limit = Math.min(MAX_DECODED_BYTES, this.decodedRemaining);
    const filter = dict.getRaw("Filter");
    const params = dict.getRaw("DecodeParms");
    const flate =
      isName(filter, "FlateDecode") ||
      (Array.isArray(filter) &&
        filter.length === 1 &&
        isName(filter[0], "FlateDecode"));
    const parameters =
      Array.isArray(params) && params.length === 1 ? params[0] : params;
    if ((parameters ?? null) !== null && !(parameters instanceof Dict)) {
      return null;
    }
    const predictor = parameters?.getRaw("Predictor") ?? 1;
    const colors = parameters?.getRaw("Colors") ?? 1;
    const bits = parameters?.getRaw("BitsPerComponent") ?? 8;
    const columns = parameters?.getRaw("Columns") ?? 1;
    const rowBytes = Math.ceil((colors * columns * bits) / 8);
    if (
      predictor !== 1 &&
      (!flate ||
        ![2, 10, 11, 12, 13, 14, 15].includes(predictor) ||
        !Number.isInteger(colors) ||
        colors < 1 ||
        colors > 32 ||
        !Number.isInteger(columns) ||
        columns < 1 ||
        columns > 128 ||
        ![1, 2, 4, 8, 16].includes(bits))
    ) {
      return null;
    }
    const source = bytes.subarray(start, end);
    let decoded;
    try {
      if ((filter ?? null) === null) {
        decoded = source.length <= limit ? source : null;
      } else if (
        flate &&
        limit > 0 &&
        typeof DecompressionStream === "function"
      ) {
        decoded = await readFlate(source, limit);
        this.decodedRemaining -= decoded?.length ?? limit;
        if (decoded && predictor !== 1) {
          const encodedRow = rowBytes + (predictor === 2 ? 0 : 1);
          if (decoded.length % encodedRow) {
            return null;
          }
          decoded = new PredictorStream(
            new Stream(decoded),
            decoded.length,
            parameters
          ).getBytes();
        }
        return decoded ?? null;
      }
    } catch {
      return null;
    }
    if (decoded) {
      this.decodedRemaining -= decoded.length;
    }
    return decoded ?? null;
  }

  table(offset) {
    const id = "PDF-XREF-TABLE",
      { bytes } = this;
    this.counts.tables++;
    const afterKeyword = offset + 4;
    const eol = eolSize(bytes, afterKeyword);
    let cursor = skipWhite(
      bytes,
      afterKeyword,
      Math.min(bytes.length, afterKeyword + 8192)
    );
    const singleEol = eol > 0 && cursor === afterKeyword + eol;
    this.note(
      "6.1.4-2",
      singleEol ? "pass" : "fail",
      afterKeyword,
      singleEol
        ? "One end-of-line marker follows xref."
        : "Exactly one end-of-line marker must separate xref and its first subsection."
    );
    const rows = new Map();
    if (hasToken(bytes, cursor, "trailer")) {
      this.note(id, "fail", cursor, "Cross-reference table has no subsection.");
      return null;
    }
    while (!hasToken(bytes, cursor, "trailer")) {
      const headerLimit = Math.min(bytes.length, cursor + 256);
      let end = cursor;
      while (end < headerLimit && !eolSize(bytes, end)) {
        end++;
      }
      if (end === headerLimit) {
        this.note(
          id,
          "unknown",
          cursor,
          "Cross-reference subsection header could not be bounded."
        );
        return null;
      }
      const header = /^(\d+)[ \t]+(\d+)[ \t]*$/.exec(
        bytesToString(bytes.subarray(cursor, end))
      );
      const first = Number(header?.[1]),
        count = Number(header?.[2]);
      if (
        !Number.isSafeInteger(first) ||
        !Number.isSafeInteger(count) ||
        !Number.isSafeInteger(first + count) ||
        count < 0
      ) {
        this.note(
          id,
          "fail",
          cursor,
          "Invalid cross-reference subsection header."
        );
        return null;
      }
      if (!this.acceptEntries(count, id, cursor)) {
        return null;
      }
      cursor = end + eolSize(bytes, end);
      for (let i = 0; i < count; i++) {
        const line = bytesToString(bytes.subarray(cursor, cursor + 20));
        const row = /^(\d{10}) (\d{5}) ([nf])(?: \n| \r|\r\n)$/.exec(line);
        const number = first + i;
        if (
          !row ||
          Number(row[2]) > 65535 ||
          rows.has(number) ||
          (number === 0 && (row[3] !== "f" || Number(row[2]) !== 65535))
        ) {
          this.note(
            id,
            "fail",
            cursor,
            "Malformed fixed-width cross-reference row or duplicate entry."
          );
          return null;
        }
        rows.set(number, {
          type: row[3] === "n" ? 1 : 0,
          offset: Number(row[1]),
          generation: Number(row[2]),
          location: cursor,
        });
        cursor += 20;
      }
      cursor = skipWhite(bytes, cursor, Math.min(bytes.length, cursor + 8192));
    }
    const dict = parseDictionary(bytes, cursor + 7)?.dict;
    if (!dict) {
      this.note(
        id,
        "unknown",
        cursor,
        "The trailer dictionary could not be read."
      );
      return null;
    }
    const size = dict.getRaw("Size");
    if (
      !Number.isSafeInteger(size) ||
      size < 1 ||
      [...rows.keys()].some(number => number >= size)
    ) {
      this.note(
        id,
        "fail",
        cursor,
        "Invalid trailer /Size for the cross-reference rows."
      );
      return null;
    }
    this.note(
      id,
      "pass",
      offset,
      "Cross-reference table subsection and row format checked."
    );
    return { kind: "table", dict, rows, offset };
  }

  async xrefStream(offset, dict, streamOffset) {
    const id = "PDF-XREF-STREAM";
    this.counts.streams++;
    const size = dict.getRaw("Size");
    const widths = dict.getRaw("W");
    const index = dict.getRaw("Index") ?? [0, size];
    if (
      !Number.isSafeInteger(size) ||
      size < 1 ||
      !Array.isArray(widths) ||
      widths.length !== 3 ||
      widths.some(width => !Number.isSafeInteger(width) || width < 0) ||
      !Array.isArray(index) ||
      index.length < 2 ||
      index.length % 2
    ) {
      this.note(
        id,
        "fail",
        offset,
        "Invalid direct /Size, /W or /Index in cross-reference stream."
      );
      return { kind: "stream", dict, rows: null, offset };
    }
    let previousEnd = 0,
      count = 0;
    for (let i = 0; i < index.length; i += 2) {
      const first = index[i],
        length = index[i + 1];
      if (
        !Number.isSafeInteger(first) ||
        !Number.isSafeInteger(length) ||
        first < previousEnd ||
        length < 0 ||
        first + length > size
      ) {
        this.note(
          id,
          "fail",
          offset,
          "Cross-reference stream /Index ranges overlap, are unsorted, or exceed /Size."
        );
        return { kind: "stream", dict, rows: null, offset };
      }
      previousEnd = first + length;
      count += length;
    }
    if (widths.some(width => width > 6)) {
      this.note(
        id,
        "unknown",
        offset,
        "Cross-reference stream field width is outside the inspection limits."
      );
      return { kind: "stream", dict, rows: null, offset };
    }
    if (!this.acceptEntries(count, id, offset)) {
      return { kind: "stream", dict, rows: null, offset };
    }
    const decoded = await this.decode(dict, streamOffset);
    if (!decoded) {
      this.note(
        id,
        "unknown",
        offset,
        "Cross-reference stream bounds, filter or decoder could not be verified."
      );
      return { kind: "stream", dict, rows: null, offset };
    }
    const rowWidth = widths[0] + widths[1] + widths[2];
    if (decoded.length !== count * rowWidth) {
      this.note(
        id,
        "fail",
        offset,
        "Decoded cross-reference stream length does not match /W and /Index."
      );
      return { kind: "stream", dict, rows: null, offset };
    }
    const rows = new Map();
    let position = 0;
    const readField = width => {
      let value = 0;
      for (let i = 0; i < width; i++) {
        value = value * 256 + decoded[position++];
      }
      return value;
    };
    for (let i = 0; i < index.length; i += 2) {
      for (let j = 0; j < index[i + 1]; j++) {
        const type = widths[0] ? readField(widths[0]) : 1;
        const pointer = readField(widths[1]);
        const generation = readField(widths[2]);
        const number = index[i] + j;
        if (type > 2) {
          // Readers treat reserved types as null, but evidence remains open.
          this.note(
            id,
            "unknown",
            offset,
            "Cross-reference stream uses a reserved entry type."
          );
          rows.set(number, { type: 0, location: offset });
          continue;
        }
        if ((type <= 1 && generation > 65535) || (number === 0 && type !== 0)) {
          this.note(
            id,
            "fail",
            offset,
            "Invalid generation or object-zero entry in cross-reference stream."
          );
          return { kind: "stream", dict, rows: null, offset };
        }
        rows.set(number, {
          type,
          offset: pointer,
          generation,
          location: offset,
        });
      }
    }
    this.note(
      id,
      "pass",
      offset,
      "Cross-reference stream ranges and decoded row widths checked."
    );
    return { kind: "stream", dict, rows, offset };
  }

  async section(offset, id, streamOnly = false) {
    const { bytes } = this;
    if (hasToken(bytes, offset, "xref") && !streamOnly) {
      this.note(id, "pass", offset, "Cross-reference pointer targets a table.");
      return this.table(offset);
    }
    const header = objectHeader(bytes, offset);
    const parsed =
      header && !header.limited && parseDictionary(bytes, header.end);
    if (
      (parsed?.streamOffset ?? null) !== null &&
      isName(parsed.dict.getRaw("Type"), "XRef")
    ) {
      this.note(
        id,
        "pass",
        offset,
        "Cross-reference pointer targets an XRef stream."
      );
      return this.xrefStream(offset, parsed.dict, parsed.streamOffset);
    }
    this.note(
      id,
      header && !parsed ? "unknown" : "fail",
      offset,
      "Cross-reference pointer does not resolve to the expected table or XRef stream."
    );
    return null;
  }

  inspectObjectOffsets(rows) {
    const id = "PDF-XREF-ENTRY";
    for (const [number, row] of rows) {
      if (row.type !== 1) {
        continue;
      }
      const header = objectHeader(this.bytes, row.offset);
      if (header?.limited) {
        this.note(
          id,
          "unknown",
          row.location,
          "Indirect object header exceeds the inspection limit."
        );
        continue;
      }
      const valid =
        header?.number === number && header.generation === row.generation;
      this.note(
        id,
        valid ? "pass" : "fail",
        row.location,
        valid
          ? "Uncompressed offsets point to matching indirect object headers."
          : `Entry ${number} ${row.generation} points to byte ${row.offset} without a matching indirect object header.`
      );
    }
  }

  async readObjectStream(container, offset) {
    const header = objectHeader(this.bytes, offset);
    const parsed =
      header && !header.limited && parseDictionary(this.bytes, header.end);
    if (!parsed || this.encrypted) {
      return { unknown: true };
    }
    if (
      header.number !== container ||
      header.generation !== 0 ||
      !isName(parsed.dict.getRaw("Type"), "ObjStm") ||
      parsed.streamOffset === null
    ) {
      return {};
    }
    const n = parsed.dict.getRaw("N");
    const first = parsed.dict.getRaw("First");
    if (n instanceof Ref || first instanceof Ref) {
      return { unknown: true };
    }
    if (
      !Number.isSafeInteger(n) ||
      n < 1 ||
      !Number.isSafeInteger(first) ||
      first < 1
    ) {
      return {};
    }
    if (n > MAX_ENTRIES) {
      return { unknown: true };
    }
    const decoded = await this.decode(parsed.dict, parsed.streamOffset);
    if (!decoded) {
      return { unknown: true };
    }
    if (first >= decoded.length) {
      return {};
    }
    try {
      const lexer = new Lexer(new Stream(decoded.subarray(0, first)));
      const numbers = [],
        offsets = [];
      const seen = new Set();
      let previous = -1;
      for (let i = 0; i < n; i++) {
        const number = lexer.getObj(),
          relative = lexer.getObj();
        if (
          !Number.isSafeInteger(number) ||
          number < 1 ||
          seen.has(number) ||
          !Number.isSafeInteger(relative) ||
          relative <= previous ||
          (i === 0 && relative !== 0) ||
          first + relative >= decoded.length ||
          isWhite(decoded[first + relative]) ||
          decoded[first + relative] === 37
        ) {
          return {};
        }
        seen.add(number);
        numbers.push(number);
        offsets.push(first + relative);
        previous = relative;
      }
      if (lexer.getObj() !== EOF) {
        return {};
      }
      for (let i = 0; i < offsets.length; i++) {
        const body = decoded.subarray(offsets[i], offsets[i + 1]);
        const parser = new Parser({
          lexer: new Lexer(new Stream(body)),
          xref: null,
        });
        const object = parser.getObj();
        if (
          object === EOF ||
          object instanceof Cmd ||
          parser.getObj() !== EOF
        ) {
          return {};
        }
      }
      return { numbers };
    } catch {
      return {};
    }
  }

  async inspectRows(revisions, chainComplete) {
    const id = "PDF-OBJECT-STREAM",
      latest = new Map(),
      cache = new Map();
    let effectiveComplete = chainComplete;
    for (const revision of revisions.reverse()) {
      const current = new Map();
      // In a hybrid revision, the standard table takes precedence.
      if (revision.hasSupplement && !revision.supplement?.rows) {
        effectiveComplete = false;
      }
      for (const section of [revision.supplement, revision.primary]) {
        if (!section) {
          continue;
        }
        if (!section.rows) {
          effectiveComplete = false;
          continue;
        }
        this.inspectObjectOffsets(section.rows);
        for (const [number, row] of section.rows) {
          current.set(number, row);
        }
      }
      for (const [number, row] of current) {
        latest.set(number, row);
      }
      // Latest inherited compressed entries may point to a replaced stream.
      const entries = revision === revisions.at(-1) ? latest : current;
      for (const [number, row] of entries) {
        if (row.type !== 2) {
          continue;
        }
        if (
          !effectiveComplete &&
          (!current.has(number) || !current.has(row.offset))
        ) {
          this.note(
            id,
            "unknown",
            row.location,
            "An unreadable revision may override the compressed entry or its stream."
          );
          continue;
        }
        const container = latest.get(row.offset);
        if (!container || container.type !== 1 || container.generation !== 0) {
          this.note(
            id,
            effectiveComplete ? "fail" : "unknown",
            row.location,
            `Compressed entry ${number} has no usable generation-zero object stream.`
          );
          continue;
        }
        const key = `${row.offset}@${container.offset}`;
        if (!cache.has(key)) {
          if (cache.size >= MAX_OBJECT_STREAMS) {
            this.note(
              id,
              "unknown",
              row.location,
              "Object stream inspection limit exceeded."
            );
            continue;
          }
          this.counts.objectStreams++;
          cache.set(
            key,
            await this.readObjectStream(row.offset, container.offset)
          );
        }
        const result = cache.get(key);
        if (result.unknown) {
          this.note(
            id,
            "unknown",
            container.offset,
            "Object stream could not be decoded within inspection limits."
          );
        } else {
          const valid = result.numbers?.[row.generation] === number;
          this.note(
            id,
            valid ? "pass" : "fail",
            container.offset,
            valid
              ? "Compressed cross-reference entries match the object stream headers."
              : `Invalid object stream header or compressed entry ${number} does not match slot ${row.generation}.`
          );
        }
      }
    }
    if (!effectiveComplete) {
      for (const rule of ["PDF-XREF-ENTRY", id]) {
        this.note(
          rule,
          "unknown",
          null,
          "The complete cross-reference entry chain could not be inspected."
        );
      }
    }
  }

  async inspect(offset) {
    const id = "PDF-XREF-PREV",
      seen = new Set(),
      revisions = [];
    let complete = false;
    while (seen.size < MAX_SECTIONS) {
      seen.add(offset);
      const primary = await this.section(
        offset,
        seen.size === 1 ? "PDF-XREF-TARGET" : id
      );
      if (!primary) {
        this.note(
          id,
          "unknown",
          offset,
          "The revision trailer could not be inspected."
        );
        break;
      }
      this.counts.revisions++;
      let supplement;
      const hasSupplement =
        primary.kind === "table" &&
        (primary.dict.getRaw("XRefStm") ?? null) !== null;
      if (hasSupplement) {
        const pointer = primary.dict.getRaw("XRefStm");
        if (
          !Number.isSafeInteger(pointer) ||
          pointer <= 0 ||
          pointer >= offset
        ) {
          this.note(
            id,
            "fail",
            offset,
            "Invalid /XRefStm pointer for a hybrid revision."
          );
        } else {
          supplement = await this.section(pointer, id, true);
        }
      }
      revisions.push({ primary, supplement, hasSupplement });
      if ((primary.dict.getRaw("Prev") ?? null) === null) {
        this.note(
          id,
          "pass",
          offset,
          "Primary revision chain ends without another /Prev pointer."
        );
        complete = true;
        break;
      }
      const previous = primary.dict.getRaw("Prev");
      if (
        !Number.isSafeInteger(previous) ||
        previous <= 0 ||
        previous >= offset ||
        seen.has(previous)
      ) {
        this.note(
          id,
          "fail",
          offset,
          "Primary /Prev must point directly to an earlier cross-reference section."
        );
        break;
      }
      offset = previous;
    }
    if (!complete) {
      for (const rule of IDS) {
        this.note(
          rule,
          "unknown",
          null,
          "The complete revision chain could not be inspected."
        );
      }
    }
    await this.inspectRows(revisions, complete);
  }
}

async function inspectPdfAXRef(stream, { linearized, encrypted }) {
  const { end } = stream;
  if (end > MAX_FILE_BYTES || linearized) {
    const inspection = new PdfAXRefInspection(null, encrypted);
    inspection.unknownAll(
      linearized
        ? "Linearized cross-reference layout is outside this inspection."
        : "File exceeds the cross-reference inspection size limit."
    );
    return inspection.finish();
  }
  // Absolute offsets in startxref and xref rows are relative to byte zero,
  // including a possible leading prefix skipped by the renderer.
  const bytes = stream.getByteRange(0, end);
  const inspection = new PdfAXRefInspection(bytes, encrypted);
  const tailStart = Math.max(0, bytes.length - 16_384);
  const tail = bytesToString(bytes.subarray(tailStart));
  const pointers = tail.matchAll(
    /[\r\n]startxref[ \t]*(?:\r\n|\r|\n)[ \t]*(\d+)[ \t]*(?:\r\n|\r|\n)%%EOF/g
  );
  let offset = null;
  let footerStart = null;
  for (const match of pointers) {
    offset = Number(match[1]);
    footerStart = tailStart + match.index;
  }
  if (offset === null) {
    inspection.unknownAll("No bounded startxref footer was found.");
  } else if (
    !Number.isSafeInteger(offset) ||
    offset <= 0 ||
    offset >= footerStart
  ) {
    inspection.unknownAll(
      "The declared startxref target is outside the document body."
    );
    inspection.note(
      "PDF-XREF-TARGET",
      "fail",
      null,
      "The declared startxref target is outside the document body."
    );
  } else {
    await inspection.inspect(offset);
  }
  return inspection.finish();
}

export { inspectPdfAXRef };
