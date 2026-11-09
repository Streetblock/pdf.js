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
    const transfer = host.get(mask, "TR");
    const count = group.color?.components ?? group.color?.device?.components;
    const components =
      Array.isArray(backdrop) && backdrop.length <= 4
        ? backdrop.map(item => host.resolve(item))
        : null;
    if (
      components?.includes(unknown) ||
      backdrop === unknown ||
      transfer === unknown
    ) {
      this.note(
        MASK,
        "unknown",
        path,
        "The mask backdrop or transfer function could not be resolved."
      );
    } else if (
      (!absent(backdrop) &&
        (components?.length !== count ||
          !components?.every(
            value => Number.isFinite(value) && value >= 0 && value <= 1
          ))) ||
      (!absent(transfer) &&
        !isName(transfer, "Identity") &&
        !(transfer instanceof Dict) &&
        !(transfer instanceof BaseStream))
    ) {
      this.note(
        MASK,
        "fail",
        path,
        "The mask backdrop or transfer function has an invalid shape."
      );
    } else if (transfer instanceof Dict || transfer instanceof BaseStream) {
      this.note(
        MASK,
        "unknown",
        path + "/TR",
        "Soft-mask transfer functions are outside this inspection."
      );
    } else {
      this.note(
        MASK,
        "pass",
        path,
        "The soft-mask subtype, source group and declared parameters were checked."
      );
    }
    return descriptor;
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
