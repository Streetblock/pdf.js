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

import { Dict, isName, Name } from "./primitives.js";
import { BaseStream } from "./base_stream.js";
import { FlateStream } from "./flate_stream.js";
import { Stream } from "./stream.js";

const BLEND = "6.2.10-1";
const PAGE = "6.2.10-2";
const GROUP = "PDF-TRANSPARENCY-GROUP";
const MASK = "PDF-SOFT-MASK";
const STATE = "PDF-TRANSPARENCY-STATE";
const RULES = [BLEND, PAGE, GROUP, MASK, STATE];
const RANK = { "not-applicable": 0, pass: 1, unknown: 2, fail: 3 };
const BLEND_MODES = new Set([
  "Normal",
  "Compatible",
  "Multiply",
  "Screen",
  "Overlay",
  "Darken",
  "Lighten",
  "ColorDodge",
  "ColorBurn",
  "HardLight",
  "SoftLight",
  "Difference",
  "Exclusion",
  "Hue",
  "Saturation",
  "Color",
  "Luminosity",
]);
const DEVICES = new Map([
  ["DeviceGray", "DefaultGray"],
  ["DeviceRGB", "DefaultRGB"],
  ["DeviceCMYK", "DefaultCMYK"],
]);
const EXCLUDED_SPACES = new Set([
  "Lab",
  "Pattern",
  "Indexed",
  "Separation",
  "DeviceN",
]);
const absent = value => value === undefined || value === null;

class TransparencyInspection {
  constructor(host, unknown) {
    this.host = host;
    this.unresolved = unknown;
    this.findings = new Map();
    this.groups = new Set();
    this.states = new Set();
    this.masks = new Set();
    this.maskImages = new Set();
    this.functionBudget = 8192;
    this.counts = {
      transparentPages: 0,
      annotationAppearances: 0,
      groups: 0,
      graphicsStates: 0,
      softMasks: 0,
      imageSoftMasks: 0,
    };
  }

  note(id, status, location, detail) {
    if (RANK[status] > (RANK[this.findings.get(id)?.status] ?? -1)) {
      this.findings.set(id, { id, status, location, detail });
    }
  }

  unknown(path, detail, includePage = false) {
    for (const id of RULES) {
      if (includePage || id !== PAGE) {
        this.note(id, "unknown", path, detail);
      }
    }
  }

  status(value, valid) {
    if (value === this.unresolved) {
      return "unknown";
    }
    return valid ? "pass" : "fail";
  }

  blend(value, path) {
    const values = Array.isArray(value) ? value : [value];
    if (values.length > 128) {
      this.note(
        BLEND,
        "unknown",
        path,
        "The blend mode array exceeds the inspection limit."
      );
      return this.unresolved;
    }

    let status = "pass";
    let selected = false;
    let found = false;
    for (const raw of values) {
      const mode = this.host.resolve(raw);
      const valid = mode instanceof Name && BLEND_MODES.has(mode.name);
      const entryStatus = this.status(mode, valid);
      if (RANK[entryStatus] > RANK[status]) {
        status = entryStatus;
      }
      // The first recognized name determines the rendering mode. Each array
      // member is independently subject to the PDF/A restriction.
      if (!found && mode === this.unresolved) {
        selected = this.unresolved;
        found = true;
      } else if (!found && valid) {
        selected = !isName(mode, "Normal") && !isName(mode, "Compatible");
        found = true;
      }
    }
    this.note(
      BLEND,
      status,
      path,
      status === "pass"
        ? "The blend modes are defined in ISO 32000-1."
        : "The blend mode is outside ISO 32000-1 or could not be resolved."
    );
    return selected;
  }

  async blendColor(raw, resources, path, depth = 0, remap = true) {
    if (depth >= 16) {
      return this.unresolved;
    }
    const space = this.host.resolve(raw);
    const type = Array.isArray(space) ? space[0] : space;
    if (!(type instanceof Name)) {
      return space === this.unresolved ? this.unresolved : false;
    }
    if (EXCLUDED_SPACES.has(type.name)) {
      return false;
    }
    if (space instanceof Name) {
      const defaultName = DEVICES.get(space.name);
      const replacement = this.host.resource(
        resources,
        "ColorSpace",
        defaultName ?? space.name
      );
      if (!defaultName) {
        return absent(replacement)
          ? this.unresolved
          : this.blendColor(replacement, resources, path, depth + 1, remap);
      }
      if (remap && !absent(replacement)) {
        const result = await this.blendColor(
          replacement,
          resources,
          path,
          depth + 1,
          false
        );
        if (result === this.unresolved) {
          return result;
        }
        const components = result?.components ?? result?.device?.components;
        return components === DEVICES_COMPONENTS[space.name] ? result : false;
      }
    } else if (isName(type, "ICCBased")) {
      const profile = this.host.resolve(space[1]);
      if (profile instanceof BaseStream) {
        const header = await this.host.readProfile(profile);
        if (header.space === "Lab ") {
          return false;
        }
        const range = this.host.get(profile.dict, "Range");
        const components = this.host.get(profile.dict, "N");
        if (
          !absent(range) &&
          (!Array.isArray(range) ||
            !Number.isInteger(components) ||
            range.length !== 2 * components ||
            range.length > 8 ||
            !range.every(
              (value, index) => this.host.resolve(value) === index % 2
            ))
        ) {
          return this.unresolved;
        }
      }
    } else if (!isName(type, "CalGray") && !isName(type, "CalRGB")) {
      return this.unresolved;
    }
    return this.host.color(space, resources, path);
  }

  async group(owner, resources, path, kind = "form") {
    path += "/Group";
    const group = this.host.get(owner, "Group");
    if (absent(group)) {
      return { status: "absent", hasColor: false };
    }

    const unknown = this.unresolved;
    if (!(group instanceof Dict)) {
      const status = this.status(group, false);
      this.note(
        GROUP,
        status,
        path,
        "The transparency group is not a readable dictionary."
      );
      return { status, hasColor: status === "unknown" ? unknown : false };
    }
    if (!this.groups.has(group)) {
      this.groups.add(group);
      this.counts.groups++;
    }

    const { host } = this;
    const type = host.get(group, "Type");
    const subtype = host.get(group, "S");
    const isolation = host.get(group, "I");
    const knockout = host.get(group, "K");
    const space = host.get(group, "CS");
    const fields = [
      [type, absent(type) || isName(type, "Group"), "/Type"],
      [subtype, isName(subtype, "Transparency"), "/S"],
      [isolation, absent(isolation) || typeof isolation === "boolean", "/I"],
      [knockout, absent(knockout) || typeof knockout === "boolean", "/K"],
    ];
    let status = "pass";
    for (const [value, valid, key] of fields) {
      const fieldStatus = this.status(value, valid);
      if (fieldStatus !== "pass") {
        this.note(
          GROUP,
          fieldStatus,
          path + key,
          "The group dictionary contains an invalid or unresolved value."
        );
      }
      if (RANK[fieldStatus] > RANK[status]) {
        status = fieldStatus;
      }
    }

    let color = null;
    if (!absent(space)) {
      color = await this.blendColor(space, resources, path + "/CS");
      const csStatus = this.status(color, !!color);
      if (csStatus !== "pass") {
        this.note(
          GROUP,
          csStatus,
          path + "/CS",
          "The group's blending colour space is forbidden or could not be verified."
        );
      }
      if (RANK[csStatus] > RANK[status]) {
        status = csStatus;
      }
      if (kind === "form" && (absent(isolation) || isolation === false)) {
        status = "fail";
        this.note(
          GROUP,
          status,
          path + "/CS",
          "A Form transparency group with a parent may specify a blending colour space only when isolated."
        );
      }
    }

    if (status === "pass") {
      this.note(
        GROUP,
        status,
        path,
        "The transparency group fields were checked."
      );
    }
    return {
      status,
      color,
      hasColor: status === "unknown" ? unknown : status === "pass" && !!color,
      isolated: isolation === true,
    };
  }

  async graphicsState(dict, resources, path) {
    if (!this.states.has(dict)) {
      this.states.add(dict);
      this.counts.graphicsStates++;
    }
    const { host } = this;
    const delta = {};
    const blend = host.get(dict, "BM");
    if (!absent(blend)) {
      delta.blend = this.blend(blend, path + "/BM");
    }
    for (const [key, property] of [
      ["ca", "fillAlpha"],
      ["CA", "strokeAlpha"],
    ]) {
      const alpha = host.get(dict, key);
      if (absent(alpha)) {
        continue;
      }
      const status = this.status(
        alpha,
        Number.isFinite(alpha) && alpha >= 0 && alpha <= 1
      );
      this.note(
        STATE,
        status,
        path + "/" + key,
        status === "pass"
          ? "The alpha constant is in the range 0 to 1."
          : "The alpha constant must be a readable number from 0 to 1."
      );
      delta[property] = status === "pass" ? alpha : this.unresolved;
    }
    for (const key of ["AIS", "TK"]) {
      const flag = host.get(dict, key);
      if (!absent(flag)) {
        const status = this.status(flag, typeof flag === "boolean");
        this.note(
          STATE,
          status,
          path + "/" + key,
          status === "pass"
            ? "The transparency flag is boolean."
            : "The transparency flag must be a readable boolean."
        );
      }
    }
    const mask = host.get(dict, "SMask");
    if (!absent(mask)) {
      delta.mask = await this.graphicsMask(mask, resources, path + "/SMask");
    }
    return delta;
  }

  async graphicsMask(mask, resources, path) {
    const unknown = this.unresolved;
    if (isName(mask, "None")) {
      this.note(
        MASK,
        "pass",
        path,
        "The graphics state explicitly clears the soft mask."
      );
      return false;
    }
    if (!(mask instanceof Dict)) {
      this.note(
        MASK,
        this.status(mask, false),
        path,
        "The soft mask must be /None or a readable mask dictionary."
      );
      return unknown;
    }
    if (!this.masks.has(mask)) {
      this.masks.add(mask);
      this.counts.softMasks++;
    }

    const { host } = this;
    await this.transfer(host.get(mask, "TR"), path + "/TR");
    const type = host.get(mask, "Type");
    const subtype = host.get(mask, "S");
    const stream = host.get(mask, "G");
    const formType =
      stream instanceof BaseStream ? host.get(stream.dict, "Subtype") : null;
    const formResources =
      stream instanceof BaseStream ? host.get(stream.dict, "Resources") : null;
    const formObjectType =
      stream instanceof BaseStream ? host.get(stream.dict, "Type") : null;
    if ([type, subtype, stream, formType, formObjectType].includes(unknown)) {
      this.note(
        MASK,
        "unknown",
        path,
        "The mask type or source Form could not be resolved."
      );
      return unknown;
    }

    const luminosity = isName(subtype, "Luminosity");
    if (
      (!absent(type) && !isName(type, "Mask")) ||
      (!luminosity && !isName(subtype, "Alpha")) ||
      !(stream instanceof BaseStream) ||
      !isName(formType, "Form") ||
      (!absent(formObjectType) && !isName(formObjectType, "XObject"))
    ) {
      this.note(
        MASK,
        "fail",
        path,
        "The soft mask requires /Alpha or /Luminosity and a source Form XObject."
      );
      return unknown;
    }

    const group = await this.group(
      stream.dict,
      absent(formResources) ? resources : formResources,
      path + "/G",
      luminosity ? "luminosity-mask" : "alpha-mask"
    );
    const descriptor = { stream, subtype: subtype.name };
    if (group.status === "unknown") {
      this.note(
        MASK,
        "unknown",
        path + "/G",
        "The soft-mask transparency group could not be verified."
      );
      return descriptor;
    }
    if (group.status !== "pass" || (luminosity && !group.hasColor)) {
      this.note(
        MASK,
        "fail",
        path + "/G",
        "The source must be a transparency group with an explicit blending colour space for /Luminosity."
      );
      return descriptor;
    }

    const backdrop = luminosity ? host.get(mask, "BC") : null;
    const count = group.color?.components ?? group.color?.device?.components;
    const components =
      Array.isArray(backdrop) && backdrop.length <= 4
        ? backdrop.map(item => host.resolve(item))
        : null;
    if (components?.includes(unknown) || backdrop === unknown) {
      this.note(
        MASK,
        "unknown",
        path,
        "The mask backdrop could not be resolved."
      );
    } else if (
      !absent(backdrop) &&
      (components?.length !== count ||
        !components?.every(
          value => Number.isFinite(value) && value >= 0 && value <= 1
        ))
    ) {
      this.note(MASK, "fail", path, "The mask backdrop has an invalid shape.");
    } else {
      this.note(
        MASK,
        "pass",
        path,
        "The soft-mask subtype, source group and backdrop were checked."
      );
    }
    return descriptor;
  }

  functionArray(dict, key, length, fallback, path) {
    const raw = this.host.get(dict, key);
    const value = absent(raw) && fallback ? fallback : raw;
    let values = null;
    let status = "fail";
    if (value === this.unresolved) {
      status = "unknown";
    } else if (Array.isArray(value) && value.length === length) {
      values = value.map(item => this.host.resolve(item));
      if (
        values.some(item => item !== this.unresolved && !Number.isFinite(item))
      ) {
        status = "fail";
      } else {
        status = values.includes(this.unresolved) ? "unknown" : "pass";
      }
    }
    this.note(
      MASK,
      status,
      path + "/" + key,
      status === "pass"
        ? "The transfer function parameter has the required numeric dimensions."
        : "The transfer function parameter has invalid dimensions, nonnumeric values or unresolved references."
    );
    return status === "pass" ? values : null;
  }

  async transfer(value, path, ancestors = null) {
    if (!ancestors && (absent(value) || isName(value, "Identity"))) {
      this.note(
        MASK,
        "pass",
        path,
        "The soft mask uses the identity transfer."
      );
      return;
    }
    const dict = value instanceof BaseStream ? value.dict : value;
    if (!(dict instanceof Dict)) {
      this.note(
        MASK,
        this.status(value, false),
        path,
        "A readable function dictionary is required at this location."
      );
      return;
    }
    if (this.functionBudget-- <= 0 || ancestors?.size >= 32) {
      this.note(
        MASK,
        "unknown",
        path,
        "The transfer function inspection reached its visit or depth limit."
      );
      return;
    }
    const type = this.host.get(dict, "FunctionType");
    if (type === 0) {
      await this.sampledTransfer(value, dict, path);
      return;
    }
    if (type === 3) {
      const active = ancestors ?? new Set();
      if (active.has(dict)) {
        this.note(
          MASK,
          "unknown",
          path,
          "The stitching function has a cyclic reference."
        );
        return;
      }
      active.add(dict);
      try {
        await this.stitchingTransfer(dict, path, active);
      } finally {
        active.delete(dict);
      }
      return;
    }
    if (type !== 2) {
      const supported = type === 4;
      this.note(
        MASK,
        supported || type === this.unresolved ? "unknown" : "fail",
        path + "/FunctionType",
        supported
          ? "This soft-mask transfer function type is outside the current inspection."
          : "The function type is missing, invalid or could not be resolved."
      );
      return;
    }
    const domain = this.functionArray(dict, "Domain", 2, null, path);
    this.functionArray(dict, "C0", 1, [0], path);
    this.functionArray(dict, "C1", 1, [1], path);
    if (!absent(this.host.get(dict, "Range"))) {
      const range = this.functionArray(dict, "Range", 2, null, path);
      if (range && range[0] > range[1]) {
        this.note(
          MASK,
          "fail",
          path + "/Range",
          "The function range is reversed."
        );
      }
    }
    const exponent = this.host.get(dict, "N");
    this.note(
      MASK,
      this.status(exponent, Number.isFinite(exponent)),
      path + "/N",
      Number.isFinite(exponent)
        ? "The Type 2 exponent is a finite number."
        : "The Type 2 exponent is missing, nonnumeric or unresolved."
    );
    if (!domain) {
      return;
    }
    const [lower, upper] = domain;
    if (lower > upper) {
      this.note(
        MASK,
        "fail",
        path + "/Domain",
        "The function domain is reversed."
      );
    } else if (
      Number.isFinite(exponent) &&
      ((!Number.isInteger(exponent) && lower < 0) ||
        (exponent < 0 && lower <= 0 && upper >= 0))
    ) {
      this.note(
        MASK,
        "fail",
        path + "/Domain",
        "A fractional exponent requires nonnegative inputs and a negative exponent requires a domain excluding zero."
      );
    }
  }

  async stitchingTransfer(dict, path, ancestors) {
    const domain = this.functionArray(dict, "Domain", 2, null, path);
    if (!absent(this.host.get(dict, "Range"))) {
      const range = this.functionArray(dict, "Range", 2, null, path);
      if (range && range[0] > range[1]) {
        this.note(
          MASK,
          "fail",
          path + "/Range",
          "The stitching function range is reversed."
        );
      }
    }
    if (domain && domain[0] > domain[1]) {
      this.note(
        MASK,
        "fail",
        path + "/Domain",
        "The stitching function domain is reversed."
      );
    }
    const functions = this.host.get(dict, "Functions");
    if (!Array.isArray(functions) || !functions.length) {
      this.note(
        MASK,
        this.status(functions, false),
        path + "/Functions",
        "A stitching function requires a nonempty array of scalar functions."
      );
      return;
    }
    if (functions.length > 512) {
      this.note(
        MASK,
        "unknown",
        path + "/Functions",
        "The function array exceeds the inspection limit."
      );
      return;
    }
    const count = functions.length;
    const bounds = this.functionArray(dict, "Bounds", count - 1, null, path);
    this.functionArray(dict, "Encode", count * 2, null, path);
    if (domain && count > 1 && domain[0] === domain[1]) {
      this.note(
        MASK,
        "fail",
        path + "/Domain",
        "A multi-part stitching function requires a nonzero domain interval."
      );
    }
    if (bounds) {
      let previous = domain?.[0];
      for (const boundary of bounds) {
        if (
          (previous !== undefined && boundary <= previous) ||
          (domain && boundary > domain[1])
        ) {
          this.note(
            MASK,
            "fail",
            path + "/Bounds",
            "Bounds must increase strictly above the domain's lower endpoint and not exceed its upper endpoint."
          );
        }
        previous = boundary;
      }
    }
    for (let i = 0; i < count; i++) {
      if (this.functionBudget <= 0) {
        this.note(
          MASK,
          "unknown",
          path + "/Functions",
          "The function inspection reached its visit limit."
        );
        break;
      }
      await this.transfer(
        this.host.resolve(functions[i]),
        path + "/Functions[" + i + "]",
        ancestors
      );
    }
  }

  async sampledTransfer(stream, dict, path) {
    if (!(stream instanceof BaseStream)) {
      this.note(
        MASK,
        "fail",
        path,
        "A Type 0 transfer function requires a sample data stream."
      );
      return;
    }
    for (const key of ["Domain", "Range"]) {
      const interval = this.functionArray(dict, key, 2, null, path);
      if (interval && interval[0] > interval[1]) {
        this.note(
          MASK,
          "fail",
          path + "/" + key,
          "The sampled function interval is reversed."
        );
      }
    }
    const size = this.functionArray(dict, "Size", 1, null, path);
    if (size) {
      this.note(
        MASK,
        Number.isInteger(size[0]) && size[0] > 0 ? "pass" : "fail",
        path + "/Size",
        "The sample count must be a positive integer."
      );
    }
    const bits = this.host.get(dict, "BitsPerSample");
    const validBits = [1, 2, 4, 8, 12, 16, 24, 32].includes(bits);
    this.note(
      MASK,
      this.status(bits, validBits),
      path + "/BitsPerSample",
      validBits
        ? "The sample bit depth is allowed for a Type 0 function."
        : "The sample bit depth is missing, unsupported or unresolved."
    );
    const declaredOrder = this.host.get(dict, "Order");
    const order = absent(declaredOrder) ? 1 : declaredOrder;
    this.note(
      MASK,
      this.status(order, order === 1 || order === 3),
      path + "/Order",
      "The interpolation order must be 1 or 3."
    );
    for (const key of ["Encode", "Decode"]) {
      if (!absent(this.host.get(dict, key))) {
        this.functionArray(dict, key, 2, null, path);
      }
    }
    if (!size || !Number.isInteger(size[0]) || size[0] <= 0 || !validBits) {
      return;
    }
    if (!Number.isSafeInteger(size[0])) {
      this.note(
        MASK,
        "unknown",
        path + "/Size",
        "The declared sample count exceeds exact integer inspection."
      );
      return;
    }
    const bytes = await this.sampleBytes(stream);
    if (!bytes) {
      this.note(
        MASK,
        "unknown",
        path,
        "The original sample data could not be decoded within the supported filters and byte budget."
      );
      return;
    }
    const required = (BigInt(size[0]) * BigInt(bits) + 7n) / 8n;
    this.note(
      MASK,
      BigInt(bytes.length) >= required ? "pass" : "fail",
      path,
      "The sampled function requires at least " +
        required +
        " decoded sample bytes."
    );
  }

  async sampleBytes(stream) {
    const { host } = this;
    const dict = stream.dict;
    const filter = host.get(dict, "Filter");
    let filters = [];
    if (!absent(filter)) {
      filters = Array.isArray(filter) ? filter : [filter];
    }
    // PDF.js can ignore unsupported filters. Check original declarations and
    // decoder classes before treating any bytes as decoded samples.
    if (!absent(host.get(dict, "DP")) || filters.length > 1) {
      return null;
    }
    if (!filters.length) {
      return stream instanceof Stream ? host.bytes(stream) : null;
    }
    const name = host.resolve(filters[0]);
    if (
      (!isName(name, "FlateDecode") && !isName(name, "Fl")) ||
      !(stream instanceof FlateStream)
    ) {
      return null;
    }
    let parameters = host.get(dict, "DecodeParms");
    if (Array.isArray(parameters)) {
      parameters =
        parameters.length === 1 ? host.resolve(parameters[0]) : this.unresolved;
    }
    if (!absent(parameters)) {
      if (!(parameters instanceof Dict)) {
        return null;
      }
      const predictor = host.get(parameters, "Predictor");
      if (!absent(predictor) && predictor !== 1) {
        return null;
      }
    }
    return host.bytes(stream);
  }

  async image(dict, resources, path) {
    const { host } = this;
    const unknown = this.unresolved;
    const mask = host.get(dict, "SMask");
    const inData = host.get(dict, "SMaskInData");
    let embedded = false;
    if (!absent(inData)) {
      const modeStatus = this.status(
        inData,
        inData === 0 || inData === 1 || inData === 2
      );
      if (modeStatus !== "pass") {
        this.note(
          MASK,
          modeStatus,
          path + "/SMaskInData",
          "The embedded alpha mode must be 0, 1 or 2."
        );
        embedded = unknown;
      } else if (inData !== 0) {
        const filter = host.get(dict, "Filter");
        const filters = Array.isArray(filter) ? filter : [filter];
        const resolved =
          filters.length <= 16
            ? filters.map(value => host.resolve(value))
            : null;
        const jpx = resolved?.some(value => isName(value, "JPXDecode"));
        if (jpx || !resolved || resolved.includes(unknown)) {
          embedded = unknown;
          if (jpx && !absent(mask) && mask !== unknown) {
            this.note(
              MASK,
              "fail",
              path + "/SMask",
              "JPX embedded alpha and a separate image soft mask are mutually exclusive."
            );
          } else {
            this.note(
              MASK,
              "unknown",
              path + "/SMaskInData",
              "Encoded alpha samples or the image filter could not be verified."
            );
          }
        }
      } else {
        this.note(
          MASK,
          "pass",
          path + "/SMaskInData",
          "Encoded alpha samples are explicitly ignored."
        );
      }
    }

    if (absent(mask)) {
      return embedded;
    }
    path += "/SMask";
    if (!(mask instanceof BaseStream)) {
      this.note(
        MASK,
        this.status(mask, false),
        path,
        "An image soft mask must be a readable Image XObject stream."
      );
      return unknown;
    }
    if (!this.maskImages.has(mask)) {
      this.maskImages.add(mask);
      this.counts.imageSoftMasks++;
    }

    const m = mask.dict;
    const type = host.get(m, "Type");
    const subtype = host.get(m, "Subtype");
    const imageMask = host.get(m, "ImageMask");
    const nestedMask = host.get(m, "Mask");
    const nestedSoft = host.get(m, "SMask");
    const nestedInData = host.get(m, "SMaskInData");
    const color = host.get(m, "ColorSpace");
    const bits = host.get(m, "BitsPerComponent");
    const width = host.get(m, "Width");
    const height = host.get(m, "Height");
    const external = host.get(m, "F");
    const fields = [
      [type, absent(type) || isName(type, "XObject"), "/Type"],
      [subtype, isName(subtype, "Image"), "/Subtype"],
      [imageMask, absent(imageMask) || imageMask === false, "/ImageMask"],
      [nestedMask, absent(nestedMask), "/Mask"],
      [nestedSoft, absent(nestedSoft), "/SMask"],
      [
        nestedInData,
        absent(nestedInData) || nestedInData === 0,
        "/SMaskInData",
      ],
      [color, isName(color, "DeviceGray"), "/ColorSpace"],
      [bits, [1, 2, 4, 8, 16].includes(bits), "/BitsPerComponent"],
      [width, Number.isSafeInteger(width) && width > 0, "/Width"],
      [height, Number.isSafeInteger(height) && height > 0, "/Height"],
      [external, absent(external), "/F"],
    ];
    for (const [value, valid, key] of fields) {
      const status = this.status(value, valid);
      this.note(
        MASK,
        status,
        path + key,
        status === "pass"
          ? "The image soft-mask dictionary fields were checked."
          : "The image soft-mask field is invalid or could not be resolved."
      );
    }

    const matte = host.get(m, "Matte");
    if (!absent(matte)) {
      const parentColor = await host.color(
        host.get(dict, "ColorSpace"),
        resources,
        path
      );
      const parentWidth = host.get(dict, "Width");
      const parentHeight = host.get(dict, "Height");
      const count = parentColor?.components ?? parentColor?.device?.components;
      const values =
        Array.isArray(matte) && matte.length <= 4
          ? matte.map(value => host.resolve(value))
          : null;
      if (
        !count ||
        values?.includes(unknown) ||
        [matte, parentWidth, parentHeight, width, height].includes(unknown)
      ) {
        this.note(
          MASK,
          "unknown",
          path + "/Matte",
          "The matte dimensions or component count could not be established."
        );
      } else {
        const valid =
          values?.length === count &&
          values.every(Number.isFinite) &&
          width === parentWidth &&
          height === parentHeight;
        this.note(
          MASK,
          valid ? "pass" : "fail",
          path + "/Matte",
          "The matte must match the image dimensions and colour components."
        );
      }
    }
    return true;
  }

  page(group, usesTransparency, output, path) {
    if (usesTransparency === false) {
      return;
    }
    if (usesTransparency === true) {
      this.counts.transparentPages++;
    }
    if (typeof output === "string" || group.hasColor === true) {
      this.note(
        PAGE,
        "pass",
        path,
        "A PDF/A output profile or an explicit page blending colour space is available."
      );
    } else if (
      [usesTransparency, output, group.hasColor].includes(this.unresolved)
    ) {
      this.note(
        PAGE,
        "unknown",
        path,
        "Page transparency or its blending colour space could not be fully established."
      );
    } else {
      this.note(
        PAGE,
        "fail",
        path,
        "The page uses transparency without a PDF/A output intent or a group with a blending colour space."
      );
    }
  }

  finish() {
    return {
      checks: RULES.map(
        id =>
          this.findings.get(id) ?? {
            id,
            status: "not-applicable",
            location: "",
            detail:
              "No applicable transparency evidence in the inspected scope.",
          }
      ),
      counts: this.counts,
    };
  }
}

const DEVICES_COMPONENTS = { DeviceGray: 1, DeviceRGB: 3, DeviceCMYK: 4 };

export { TransparencyInspection };
