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
import { MissingDataException } from "./core_utils.js";
import { readFlate } from "./pdfa_xref_inspection.js";
import { Stream } from "./stream.js";
import { TransparencyInspection } from "./pdfa_transparency_inspection.js";

const INTENT = "PDF-OUTPUT-INTENT",
  ICC = "PDF-ICC-STRUCTURE";
const OUTPUT = "6.2.3-1",
  SHARED = "6.2.3-2",
  EXTERNAL = "6.2.3-3";
const INPUT = "6.2.4.2-1";
const DEVICES = new Map([
  [
    "DeviceRGB",
    {
      id: "6.2.4.3-2",
      signature: "RGB ",
      components: 3,
      substitute: "DefaultRGB",
    },
  ],
  [
    "DeviceCMYK",
    {
      id: "6.2.4.3-3",
      signature: "CMYK",
      components: 4,
      substitute: "DefaultCMYK",
    },
  ],
  [
    "DeviceGray",
    {
      id: "6.2.4.3-4",
      signature: "GRAY",
      components: 1,
      substitute: "DefaultGray",
    },
  ],
]);
const PAINT = [
  ICC,
  INPUT,
  ...Array.from(DEVICES.values(), device => device.id),
];
const RULES = [INTENT, OUTPUT, SHARED, EXTERNAL, ...PAINT];
const UNKNOWN = Symbol("unknown");
const OPAQUE = { blend: false, fillAlpha: 1, strokeAlpha: 1, mask: false };
const RANK = { "not-applicable": 0, pass: 1, unknown: 2, fail: 3 };
const MAX_DEPTH = 32,
  MAX_ITEMS = 8192,
  MAX_OPS = 200000;
const MAX_BYTES = 4 * 1024 * 1024,
  TOTAL_BYTES = 16 * 1024 * 1024;
const CHANNELS = new Map([
  ["GRAY", 1],
  ["RGB ", 3],
  ["CMYK", 4],
  ["Lab ", 3],
]);
const INPUT_CLASSES = new Set(["prtr", "mntr", "scnr", "spac"]);
const SHORTCUTS = {
  g: "DeviceGray",
  G: "DeviceGray",
  rg: "DeviceRGB",
  RG: "DeviceRGB",
  k: "DeviceCMYK",
  K: "DeviceCMYK",
};
const FILL = new Set(["f", "F", "f*", "B", "B*", "b", "b*"]);
const STROKE = new Set(["S", "s", "B", "B*", "b", "b*"]);
const TEXT = new Set(["Tj", "TJ", "'", '"']);

const absent = value => value === null || value === undefined;
const at = (path, key) => path + "/" + key;

function profileHeader(bytes) {
  if (!bytes) {
    return { status: "unknown" };
  }
  if (bytes.length < 132) {
    return { status: "fail" };
  }
  const word = offset =>
    String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = view.getUint32(0),
    count = view.getUint32(128);
  const dataStart = 132 + 12 * count;
  if (
    word(36) !== "acsp" ||
    !count ||
    size < dataStart ||
    size > bytes.length
  ) {
    return { status: "fail" };
  }
  if (count > 4096 || size < bytes.length) {
    return { status: "unknown" };
  }
  for (let i = 0; i < count; i++) {
    const offset = view.getUint32(136 + 12 * i),
      length = view.getUint32(140 + 12 * i);
    if (
      offset < dataStart ||
      offset % 4 ||
      length < 8 ||
      offset + length > size
    ) {
      return { status: "fail" };
    }
  }
  return {
    status: "pass",
    deviceClass: word(12),
    space: word(16),
    major: bytes[8],
  };
}

class ColorInspection {
  constructor(xref) {
    this.xref = xref;
    this.results = new Map();
    this.counts = {
      pages: 0,
      streams: 0,
      outputIntents: 0,
      iccProfiles: 0,
      deviceUses: 0,
    };
    this.byteBudget = TOTAL_BYTES;
    this.items = MAX_ITEMS;
    this.ops = MAX_OPS;
    this.bytesCache = new Map();
    this.profiles = new Map();
    this.pageNodes = new Set();
    this.resourceNodes = new Set();
    this.forms = new Set();
    this.output = null;
    this.pageUse = null;
    this.transparency = new TransparencyInspection(this, UNKNOWN);
  }

  note(id, status, location, detail) {
    if (RANK[status] > (RANK[this.results.get(id)?.status] ?? -1)) {
      this.results.set(id, { id, status, location, detail });
    }
  }

  check(id, condition, path, failure) {
    this.note(
      id,
      condition ? "pass" : "fail",
      path,
      condition ? "Checked the supported condition." : failure
    );
  }

  unknown(path, detail, ids = PAINT) {
    for (const id of ids) {
      this.note(id, "unknown", path, detail);
    }
  }

  useTransparency(evidence) {
    if (
      this.pageUse &&
      this.pageUse.transparent !== true &&
      evidence !== false
    ) {
      this.pageUse.transparent = evidence;
    }
  }

  unavailable(path, detail) {
    this.unknown(path, detail);
    this.transparency.unknown(path, detail, !this.pageUse);
    this.useTransparency(UNKNOWN);
  }

  take(path, depth) {
    if (depth <= MAX_DEPTH && this.items-- > 0) {
      return true;
    }
    this.unknown(path, "The color inspection reached its traversal limit.");
    return false;
  }

  resolve(value) {
    if (!(value instanceof Ref)) {
      return value === CIRCULAR_REF ? UNKNOWN : value;
    }
    try {
      const entry = this.xref.getEntry(value.num);
      if (!entry || (entry.uncompressed ? entry.gen : 0) !== value.gen) {
        return UNKNOWN;
      }
      const resolved = this.xref.fetch(value);
      return absent(resolved) || resolved === CIRCULAR_REF ? UNKNOWN : resolved;
    } catch (error) {
      if (error instanceof MissingDataException) {
        throw error;
      }
      return UNKNOWN;
    }
  }

  get(dict, key) {
    return this.resolve(dict?.getRaw(key));
  }

  async bytes(stream) {
    if (
      !(stream instanceof BaseStream) ||
      !absent(this.get(stream.dict, "F"))
    ) {
      return null;
    }
    if (this.bytesCache.has(stream)) {
      return this.bytesCache.get(stream);
    }
    let bytes = null;
    const source = stream instanceof FlateStream ? stream.stream : stream;
    const limit = Math.min(MAX_BYTES, this.byteBudget);
    if (limit > 0 && source instanceof Stream && source.length <= MAX_BYTES) {
      try {
        if (stream instanceof FlateStream) {
          if (typeof DecompressionStream === "function") {
            bytes = await readFlate(
              source.getByteRange(source.start, source.end),
              limit
            );
          }
        } else if (source.length <= limit) {
          bytes = source.getByteRange(source.start, source.end);
        }
      } catch (error) {
        if (error instanceof MissingDataException) {
          throw error;
        }
      }
    }
    this.bytesCache.set(stream, bytes);
    if (bytes) {
      this.byteBudget -= bytes.length;
      this.counts.streams++;
    }
    return bytes;
  }

  async readProfile(stream) {
    if (!this.profiles.has(stream)) {
      this.counts.iccProfiles++;
      const external = this.get(stream.dict, "F");
      this.profiles.set(
        stream,
        external !== UNKNOWN && !absent(external)
          ? { status: "fail" }
          : profileHeader(await this.bytes(stream))
      );
    }
    return this.profiles.get(stream);
  }

  async profile(stream, path, use) {
    const id = use === "output" ? OUTPUT : INPUT;
    if (!(stream instanceof BaseStream)) {
      const status = stream === UNKNOWN ? "unknown" : "fail";
      this.note(
        ICC,
        status,
        path,
        "The ICC profile is not a readable embedded stream."
      );
      this.note(
        id,
        status,
        path,
        "No embedded ICC profile stream could be verified."
      );
      return null;
    }
    const profile = await this.readProfile(stream);
    this.note(
      ICC,
      profile.status,
      path,
      {
        pass: "ICC signature, profile size and tag extents were checked.",
        fail: "The ICC stream is external or its signature, size or tag extents are invalid.",
        unknown: "ICC profile bytes could not be fully inspected.",
      }[profile.status]
    );
    if (profile.status !== "pass") {
      this.note(
        id,
        profile.status,
        path,
        "The original ICC profile header could not be verified."
      );
      return null;
    }
    const output = use === "output";
    const allowedClass = output
      ? ["prtr", "mntr"].includes(profile.deviceClass)
      : INPUT_CLASSES.has(profile.deviceClass);
    const allowedSpace =
      CHANNELS.has(profile.space) && (!output || profile.space !== "Lab ");
    const allowed =
      allowedClass && allowedSpace && profile.major >= 2 && profile.major < 5;
    this.check(
      id,
      allowed,
      path,
      "ICC profile class, data color space or version is outside the supported PDF/A-3 range."
    );
    return allowed ? profile : null;
  }

  async intents(catalog) {
    const path = "/Root/OutputIntents";
    const intents = this.get(catalog, "OutputIntents");
    if (absent(intents)) {
      return;
    }
    if (!Array.isArray(intents) || intents.length > 128) {
      this.note(
        INTENT,
        intents === UNKNOWN || Array.isArray(intents) ? "unknown" : "fail",
        path,
        "The output intents entry is not a readable array of supported size."
      );
      this.output = UNKNOWN;
      return;
    }
    let common,
      unresolved = false;
    for (let i = 0; i < intents.length; i++) {
      const location = path + "[" + i + "]";
      const intent = this.resolve(intents[i]);
      if (!(intent instanceof Dict)) {
        this.note(
          INTENT,
          intent === UNKNOWN ? "unknown" : "fail",
          location,
          "Output intent is not a readable dictionary."
        );
        unresolved = true;
        continue;
      }
      this.counts.outputIntents++;
      const type = this.get(intent, "Type"),
        sub = this.get(intent, "S");
      const condition = this.get(intent, "OutputConditionIdentifier");
      const fieldsValid =
        (absent(type) || isName(type, "OutputIntent")) &&
        sub instanceof Name &&
        typeof condition === "string";
      if ([type, sub, condition].includes(UNKNOWN)) {
        this.note(
          INTENT,
          "unknown",
          location,
          "Output intent fields could not be resolved."
        );
      } else {
        this.check(
          INTENT,
          fieldsValid,
          location,
          "The output intent has an invalid type, subtype or output condition identifier."
        );
      }
      if (sub === UNKNOWN) {
        unresolved = true;
        this.note(
          EXTERNAL,
          "unknown",
          location,
          "The output intent subtype is unreadable."
        );
      } else if (isName(sub, "GTS_PDFX")) {
        this.check(
          EXTERNAL,
          absent(intent.getRaw("DestOutputProfileRef")),
          location,
          "PDF/X output intent contains an external destination profile reference."
        );
      }
      const raw = intent.getRaw("DestOutputProfile");
      if (!absent(raw) && intents.length > 1) {
        const stream = this.resolve(raw);
        const same =
          raw instanceof Ref &&
          (!common || (raw.num === common.num && raw.gen === common.gen));
        if (same && stream instanceof BaseStream) {
          const profile = await this.readProfile(stream);
          this.note(
            SHARED,
            profile.status,
            location,
            profile.status === "pass"
              ? "The shared ICC stream identity, header and tag extents were checked."
              : "The shared destination profile must be an embedded ICC stream with a readable header and tag table."
          );
        } else if (same && stream === UNKNOWN) {
          this.note(
            SHARED,
            "unknown",
            location,
            "The shared destination profile could not be resolved."
          );
        } else {
          this.note(
            SHARED,
            "fail",
            location,
            "Destination profiles must be the same indirect stream object."
          );
        }
        common ||= raw;
      }
      if (!isName(sub, "GTS_PDFA1")) {
        continue;
      }
      const stream = this.resolve(raw);
      const profilePath = at(location, "DestOutputProfile");
      const external =
        stream instanceof BaseStream ? this.get(stream.dict, "F") : null;
      if (stream === UNKNOWN || external === UNKNOWN) {
        this.note(
          INTENT,
          "unknown",
          profilePath,
          "The destination ICC stream could not be resolved."
        );
      } else {
        this.check(
          INTENT,
          stream instanceof BaseStream && absent(external),
          profilePath,
          "PDF/A output intent lacks an embedded destination ICC stream."
        );
      }
      const info = await this.profile(stream, profilePath, "output");
      if (
        !fieldsValid ||
        !info ||
        (this.output && this.output !== info.space)
      ) {
        unresolved = true;
      } else {
        this.output = info.space;
      }
    }
    if (unresolved) {
      this.output = UNKNOWN;
      if (intents.length > 1) {
        this.note(
          SHARED,
          "unknown",
          path,
          "A complete shared-profile comparison could not be made."
        );
      }
    }
  }

  resource(resources, group, name) {
    const dict =
      resources instanceof Dict ? this.get(resources, group) : resources;
    if (dict instanceof Dict) {
      return this.get(dict, name);
    }
    return absent(dict) ? undefined : UNKNOWN;
  }

  async color(raw, resources, path, depth = 0) {
    if (depth > MAX_DEPTH) {
      return UNKNOWN;
    }
    const space = this.resolve(raw);
    if (space instanceof Name) {
      if (DEVICES.has(space.name)) {
        return { device: DEVICES.get(space.name), resources };
      }
      if (space.name === "Pattern") {
        return { pattern: true };
      }
      const next = this.resource(resources, "ColorSpace", space.name);
      return absent(next)
        ? UNKNOWN
        : this.color(next, resources, path, depth + 1);
    }
    if (!Array.isArray(space) || !(space[0] instanceof Name)) {
      return UNKNOWN;
    }
    const type = space[0].name;
    if (type === "Pattern") {
      return { pattern: true };
    }
    if (type === "ICCBased") {
      const stream = this.resolve(space[1]);
      const info = await this.profile(stream, path, "input");
      if (!info) {
        return UNKNOWN;
      }
      const n = this.get(stream.dict, "N");
      if (n === UNKNOWN) {
        this.note(
          ICC,
          "unknown",
          at(path, "N"),
          "The ICCBased component count is unreadable."
        );
        return UNKNOWN;
      }
      this.check(
        ICC,
        n === CHANNELS.get(info.space),
        at(path, "N"),
        "ICCBased /N does not match the profile's data color space."
      );
      return n === CHANNELS.get(info.space) ? { components: n } : UNKNOWN;
    }
    if (type === "Indexed") {
      const base = await this.color(
        space[1],
        resources,
        at(path, "Base"),
        depth + 1
      );
      return base === UNKNOWN ? UNKNOWN : { ...base, forbiddenDefault: true };
    }
    if (["CalGray", "CalRGB", "Lab"].includes(type)) {
      const params = this.resolve(space[1]);
      const white =
        params instanceof Dict ? this.get(params, "WhitePoint") : null;
      if (
        Array.isArray(white) &&
        white.length === 3 &&
        white.every(Number.isFinite) &&
        white[0] > 0 &&
        white[1] === 1 &&
        white[2] > 0
      ) {
        return {
          components: type === "CalGray" ? 1 : 3,
          forbiddenDefault: type === "Lab",
        };
      }
    }
    return UNKNOWN;
  }

  async resources(resources, path) {
    if (!(resources instanceof Dict) || this.resourceNodes.has(resources)) {
      return;
    }
    this.resourceNodes.add(resources);
    const spaces = this.get(resources, "ColorSpace");
    if (spaces === UNKNOWN) {
      this.unknown(
        path,
        "The color space resource dictionary could not be resolved."
      );
    } else if (spaces instanceof Dict) {
      let index = 0;
      for (const value of spaces.getRawValues()) {
        if (!this.take(path, 0)) {
          break;
        }
        await this.color(value, resources, path + "[" + index++ + "]");
      }
    }
  }

  async paint(space, path) {
    if (space?.pattern) {
      this.unavailable(path, "Pattern content is outside this inspection.");
      return;
    }
    if (space === UNKNOWN || !space) {
      this.unknown(
        path,
        "The color space used for painting could not be resolved."
      );
      return;
    }
    if (!space.device) {
      return;
    }
    this.counts.deviceUses++;
    const { device, resources } = space;
    const raw = this.resource(resources, "ColorSpace", device.substitute);
    const alternative = absent(raw)
      ? null
      : await this.color(raw, resources, at(path, device.substitute));
    const hasDefault =
      !alternative?.forbiddenDefault &&
      alternative?.components === device.components;
    const hasOutput =
      typeof this.output === "string" &&
      (device.signature === "GRAY" || this.output === device.signature);
    if (hasDefault || hasOutput) {
      this.check(device.id, true, path);
    } else if (alternative === UNKNOWN || this.output === UNKNOWN) {
      this.note(
        device.id,
        "unknown",
        path,
        "A possible default color space or output profile could not be verified."
      );
    } else {
      this.note(
        device.id,
        "fail",
        path,
        "Painting uses an uncalibrated device color without a suitable default or PDF/A output profile."
      );
    }
  }

  async composite(state, kind, path, depth, ownMask = false) {
    const alpha = state[kind === "fill" ? "fillAlpha" : "strokeAlpha"];
    const mask = ownMask ? false : state.mask;
    const activeMask = !!mask && mask !== UNKNOWN;
    if (
      state.blend === true ||
      (typeof alpha === "number" && alpha < 1) ||
      activeMask
    ) {
      this.useTransparency(true);
    } else if (
      state.blend === UNKNOWN ||
      alpha === UNKNOWN ||
      mask === UNKNOWN
    ) {
      this.useTransparency(UNKNOWN);
    }
    if (!activeMask) {
      return;
    }
    if (this.forms.has(mask.stream)) {
      this.unavailable(path, "A soft-mask Form has a cyclic reference.");
      return;
    }
    if (!this.pageUse.masks.has(mask)) {
      this.pageUse.masks.add(mask);
      await this.xobject(
        mask.stream,
        mask.sourceState.pageResources,
        mask.sourceState,
        at(path, "SMask"),
        depth + 1
      );
    }
  }

  async paintObject(state, kind, path, depth) {
    await this.composite(state, kind, path, depth);
    if (!state.ignoreColors || state[kind]?.pattern) {
      await this.paint(state[kind], path);
    }
  }

  async xobject(raw, resources, state, path, depth) {
    const obj = this.resolve(raw);
    if (!(obj instanceof BaseStream)) {
      this.unavailable(path, "The invoked XObject could not be inspected.");
      return;
    }
    const type = this.get(obj.dict, "Subtype");
    if (isName(type, "Image")) {
      const mask = this.get(obj.dict, "ImageMask");
      const ownMask = await this.transparency.image(obj.dict, resources, path);
      const hardMask = this.get(obj.dict, "Mask");
      this.useTransparency(ownMask);
      if (hardMask === UNKNOWN) {
        this.useTransparency(UNKNOWN);
      }
      const overrides =
        ownMask !== false ||
        hardMask === UNKNOWN ||
        hardMask instanceof BaseStream ||
        Array.isArray(hardMask);
      await this.composite(state, "fill", path, depth, overrides);
      if (mask === UNKNOWN) {
        this.unknown(path, "The image stencil setting could not be read.");
      } else if (
        mask === true &&
        (!state.ignoreColors || state.fill?.pattern)
      ) {
        await this.paint(state.fill, path);
      } else if (mask !== true && !state.ignoreColors) {
        await this.paint(
          await this.color(this.get(obj.dict, "ColorSpace"), resources, path),
          path
        );
      }
      return;
    }
    if (
      !isName(type, "Form") ||
      !absent(this.get(obj.dict, "Ref")) ||
      this.forms.has(obj) ||
      !this.take(path, depth)
    ) {
      this.unavailable(
        path,
        "The invoked Form is cyclic, external or unsupported."
      );
      return;
    }
    const entry = this.get(obj.dict, "Resources");
    const local = absent(entry) ? state.pageResources : entry;
    await this.resources(local, at(path, "Resources"));
    this.forms.add(obj);
    try {
      let kind = "form";
      if (state.maskSubtype === "Alpha") {
        kind = "alpha-mask";
      } else if (state.maskSubtype === "Luminosity") {
        kind = "luminosity-mask";
      }
      const group = await this.transparency.group(obj.dict, local, path, kind);
      const child = { ...state, maskSubtype: null };
      if (group.status !== "absent") {
        this.useTransparency(group.status === "pass" ? true : UNKNOWN);
        await this.composite(state, "fill", path, depth);
        Object.assign(child, OPAQUE);
        if (group.hasColor === true && !state.ignoreColors) {
          await this.paint(group.color, at(path, "Group/CS"));
        }
      }
      const bytes = await this.bytes(obj);
      if (bytes) {
        await this.content(bytes, local, child, path, depth);
      } else {
        this.unavailable(path, "Form content could not be read.");
      }
    } finally {
      this.forms.delete(obj);
    }
  }

  async content(bytes, resources, state, path, depth) {
    if (!bytes.length) {
      return;
    }
    const stack = [],
      args = [];
    let inText = false,
      hasPath = false;
    try {
      const parser = new Parser({
        lexer: new Lexer(new Stream(bytes)),
        xref: null,
      });
      while (parser.buf1 !== EOF) {
        if (
          this.ops-- <= 0 ||
          (parser.buf1 instanceof Cmd && parser.buf1.cmd === "BI")
        ) {
          this.unavailable(
            path,
            "Inline images or the operation limit prevent complete inspection."
          );
          return;
        }
        const token = parser.getObj();
        if (!(token instanceof Cmd)) {
          if (token instanceof Ref || args.length > 32) {
            throw new Error("Invalid operands");
          }
          args.push(token);
          continue;
        }
        const op = token.cmd,
          location = at(path, op);
        const definition = EvaluatorPreprocessor.opMap[op];
        if (
          !definition ||
          (definition.variableArgs
            ? args.length > definition.numArgs
            : args.length !== definition.numArgs)
        ) {
          throw new Error("Invalid operator");
        }
        if (op === "q") {
          if (stack.length >= MAX_DEPTH) {
            throw new Error("Graphics stack limit");
          }
          stack.push({ ...state });
        } else if (op === "Q") {
          if (!stack.length) {
            throw new Error("Unmatched graphics restore");
          }
          state = stack.pop();
        } else if (Object.hasOwn(SHORTCUTS, op)) {
          const kind = op === op.toUpperCase() ? "stroke" : "fill";
          state[kind] = args.every(Number.isFinite)
            ? { device: DEVICES.get(SHORTCUTS[op]), resources }
            : UNKNOWN;
        } else if (op === "cs" || op === "CS") {
          state[op === "cs" ? "fill" : "stroke"] = await this.color(
            args[0],
            resources,
            location
          );
        } else if (["m", "l", "c", "v", "y", "re"].includes(op)) {
          hasPath = true;
        } else if (op === "n" || FILL.has(op) || STROKE.has(op)) {
          if (hasPath && FILL.has(op)) {
            await this.paintObject(state, "fill", location, depth);
          }
          if (hasPath && STROKE.has(op)) {
            await this.paintObject(state, "stroke", location, depth);
          }
          hasPath = false;
        } else if (op === "Do") {
          const obj =
            args[0] instanceof Name
              ? this.resource(resources, "XObject", args[0].name)
              : UNKNOWN;
          await this.xobject(obj, resources, state, location, depth + 1);
        } else if (op === "sh") {
          await this.composite(state, "fill", location, depth);
          this.unknown(location, "Shading colors are outside this inspection.");
        } else if (op === "BT" || op === "ET") {
          if (inText === (op === "BT")) {
            throw new Error("Invalid text boundary");
          }
          inText = op === "BT";
        } else if (op === "Tr") {
          state.mode =
            Number.isInteger(args[0]) && args[0] >= 0 && args[0] <= 7
              ? args[0]
              : UNKNOWN;
        } else if (op === "Tf") {
          state.font =
            args[0] instanceof Name
              ? this.resource(resources, "Font", args[0].name)
              : UNKNOWN;
        } else if (op === "gs") {
          const gs =
            args[0] instanceof Name
              ? this.resource(resources, "ExtGState", args[0].name)
              : UNKNOWN;
          if (!(gs instanceof Dict)) {
            Object.assign(state, {
              font: UNKNOWN,
              blend: UNKNOWN,
              fillAlpha: UNKNOWN,
              strokeAlpha: UNKNOWN,
              mask: UNKNOWN,
            });
            this.unavailable(
              location,
              "The graphics state could not be inspected."
            );
          } else {
            const font = this.get(gs, "Font");
            if (!absent(font)) {
              state.font = Array.isArray(font)
                ? this.resolve(font[0])
                : UNKNOWN;
            }
            const delta = await this.transparency.graphicsState(
              gs,
              state.pageResources,
              location
            );
            const mask = delta.mask;
            if (mask && mask !== UNKNOWN) {
              // The mask source is evaluated with the graphics state at gs.
              mask.sourceState = {
                ...state,
                ...OPAQUE,
                maskSubtype: mask.subtype,
                ignoreColors: mask.subtype === "Alpha",
              };
            }
            Object.assign(state, delta);
          }
        } else if (TEXT.has(op)) {
          const shown = args.at(-1);
          const valid =
            op === "TJ"
              ? Array.isArray(shown) &&
                shown.every(
                  item => typeof item === "string" || Number.isFinite(item)
                )
              : typeof shown === "string";
          if (!valid || !inText) {
            throw new Error("Invalid text show");
          }
          if (
            (Array.isArray(shown) ? shown : [shown]).some(
              item => typeof item === "string" && item.length
            ) &&
            state.mode !== 3 &&
            state.mode !== 7
          ) {
            const font = state.font;
            if (
              state.mode === UNKNOWN ||
              !(font instanceof Dict) ||
              !(this.get(font, "Subtype") instanceof Name) ||
              isName(this.get(font, "Subtype"), "Type3")
            ) {
              this.unavailable(
                location,
                "The text rendering mode or Type 3 graphics are outside this inspection."
              );
            } else {
              const base = state.mode % 4;
              if (base === 0 || base === 2) {
                await this.paintObject(state, "fill", location, depth);
              }
              if (base === 1 || base === 2) {
                await this.paintObject(state, "stroke", location, depth);
              }
            }
          }
        }
        args.length = 0;
      }
      if (args.length || inText || stack.length) {
        this.unavailable(
          path,
          "The content stream ended in an incomplete graphics state."
        );
      }
    } catch (error) {
      if (error instanceof MissingDataException) {
        throw error;
      }
      this.unavailable(
        path,
        "Unsupported or malformed content prevented complete graphics inspection."
      );
    }
  }

  async page(raw, inherited, path, depth) {
    if (!this.take(path, depth)) {
      this.transparency.unknown(
        path,
        "The page traversal reached its limit.",
        true
      );
      return;
    }
    const node = this.resolve(raw);
    if (!(node instanceof Dict) || this.pageNodes.has(node)) {
      this.unavailable(path, "The page tree could not be fully inspected.");
      return;
    }
    this.pageNodes.add(node);
    const entry = this.get(node, "Resources");
    const resources = absent(entry) ? inherited : entry;
    const type = this.get(node, "Type");
    if (isName(type, "Pages")) {
      const kids = this.get(node, "Kids");
      if (!Array.isArray(kids) || kids.length > MAX_ITEMS) {
        this.unavailable(
          path,
          "The page-tree children could not be inspected."
        );
        return;
      }
      for (let i = 0; i < kids.length; i++) {
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
      this.unavailable(path, "A page dictionary could not be resolved.");
      return;
    }
    this.counts.pages++;
    this.pageUse = {
      transparent: false,
      masks: new Set(),
    };
    try {
      const group = await this.transparency.group(
        node,
        resources,
        path,
        "page"
      );
      if (group.hasColor === true) {
        await this.paint(group.color, at(path, "Group/CS"));
      }
      await this.pageContents(node, resources, path, depth);
      this.transparency.page(
        group,
        this.pageUse.transparent,
        this.output,
        path
      );
    } finally {
      this.pageUse = null;
    }
  }

  async pageContents(node, resources, path, depth) {
    await this.resources(resources, at(path, "Resources"));
    const annotations = this.get(node, "Annots");
    if (
      !absent(annotations) &&
      (!Array.isArray(annotations) ||
        annotations.length > MAX_ITEMS ||
        annotations.some(rawAnnot => {
          const annotation = this.resolve(rawAnnot);
          return (
            !(annotation instanceof Dict) ||
            !absent(this.get(annotation, "AP")) ||
            !absent(this.get(annotation, "CA")) ||
            !absent(this.get(annotation, "C"))
          );
        }))
    ) {
      this.unavailable(
        at(path, "Annots"),
        "Annotation appearances are outside this inspection."
      );
    }
    const contents = this.get(node, "Contents");
    if (absent(contents)) {
      return;
    }
    const streams = Array.isArray(contents) ? contents : [contents];
    if (streams.length > MAX_ITEMS) {
      this.unavailable(path, "The page contains too many content streams.");
      return;
    }
    const parts = [];
    let length = 0;
    for (const stream of streams) {
      const bytes = await this.bytes(this.resolve(stream));
      if (!bytes || (length += bytes.length) > MAX_BYTES) {
        this.unavailable(path, "The complete page content could not be read.");
        return;
      }
      parts.push(bytes);
    }
    const combined = parts.length === 1 ? parts[0] : new Uint8Array(length);
    if (parts.length !== 1) {
      let offset = 0;
      for (const bytes of parts) {
        combined.set(bytes, offset);
        offset += bytes.length;
      }
    }
    const gray = { device: DEVICES.get("DeviceGray"), resources };
    await this.content(
      combined,
      resources,
      {
        ...OPAQUE,
        fill: gray,
        stroke: gray,
        mode: 0,
        font: null,
        pageResources: resources,
      },
      at(path, "Contents"),
      depth
    );
  }

  finish() {
    return {
      checks: RULES.map(
        id =>
          this.results.get(id) ?? {
            id,
            status: "not-applicable",
            location: "",
            detail: "No applicable color evidence in the inspected scope.",
          }
      ),
      counts: this.counts,
    };
  }
}

async function inspectPdfAGraphics(xref, trusted) {
  const inspection = new ColorInspection(xref);
  const catalog =
    trusted && !xref.encrypt ? inspection.get(xref.trailer, "Root") : null;
  if (!(catalog instanceof Dict)) {
    inspection.unknown(
      "/Root",
      "The original document color objects could not be established.",
      RULES
    );
    inspection.transparency.unknown(
      "/Root",
      "The original transparency objects could not be established.",
      true
    );
  } else {
    await inspection.intents(catalog);
    await inspection.page(catalog.getRaw("Pages"), null, "/Root/Pages", 0);
  }
  return {
    colors: inspection.finish(),
    transparency: inspection.transparency.finish(),
  };
}

export { inspectPdfAGraphics };
