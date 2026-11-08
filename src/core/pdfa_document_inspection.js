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

import { CIRCULAR_REF, Dict, isName, Name, Ref } from "./primitives.js";
import { MissingDataException } from "./core_utils.js";

const MAX_DEPTH = 48;
const MAX_VISITS = 16_384;
const UNREADABLE = Symbol("unreadable");
const RANK = { "not-applicable": 0, pass: 1, unknown: 2, fail: 3 };

const ACTION_RULES = ["6.5.1-1", "6.5.1-2"];
const ANNOTATION_RULES = [
  "PDF-ANNOTATION",
  "6.3.1-1",
  "6.3.2-1",
  "6.3.2-2",
  "6.3.3-1",
  "6.3.3-2",
  "6.4.1-1",
];
const PAGE_RULES = [
  "PDF-PAGE-TREE",
  "6.5.2-2",
  ...ANNOTATION_RULES,
  ...ACTION_RULES,
];
const ALL_RULES = ["PDF-CATALOG", "6.5.2-1", "6.4.1-2", ...PAGE_RULES];

// ISO 19005-3:2012 §§ 6.3.1, 6.5.1. See the veraPDF A/B/U profiles for
// the corresponding rule identifiers.
const ANNOTATIONS = new Set([
  "Text",
  "Link",
  "FreeText",
  "Line",
  "Square",
  "Circle",
  "Polygon",
  "PolyLine",
  "Highlight",
  "Underline",
  "Squiggly",
  "StrikeOut",
  "Stamp",
  "Caret",
  "Ink",
  "Popup",
  "FileAttachment",
  "Widget",
  "PrinterMark",
  "TrapNet",
  "Watermark",
  "Redact",
]);
const ACTIONS = new Set([
  "GoTo",
  "GoToR",
  "GoToE",
  "Thread",
  "URI",
  "Named",
  "SubmitForm",
]);
const NAMED_ACTIONS = new Set([
  "NextPage",
  "PrevPage",
  "FirstPage",
  "LastPage",
]);
const DESTINATIONS = new Set([
  "XYZ",
  "Fit",
  "FitH",
  "FitV",
  "FitR",
  "FitB",
  "FitBH",
  "FitBV",
]);

function referenceLocation(path, value) {
  return value instanceof Ref ? `${path} (${value.num} ${value.gen} R)` : path;
}

function isAbsent(value) {
  return value === undefined || value === null;
}

function sameReference(left, right) {
  return (
    left instanceof Ref &&
    right instanceof Ref &&
    left.num === right.num &&
    left.gen === right.gen
  );
}

class PdfADocumentInspection {
  constructor(xref) {
    this.xref = xref;
    this.visits = 0;
    this.checks = new Map();
    this.pageNodes = new Set();
    this.annotations = new Set();
    this.actions = new Set();
    this.nameNodes = new Set();
    this.outlineItems = new Set();
    this.formFields = new Set();
    this.counts = {
      pageTreeNodes: 0,
      pages: 0,
      annotations: 0,
      actions: 0,
      nameTreeNodes: 0,
      outlineItems: 0,
      formFields: 0,
    };
  }

  note(id, status, location, detail) {
    const previous = this.checks.get(id);
    if (!previous || RANK[status] > RANK[previous.status]) {
      this.checks.set(id, { id, status, location, detail });
    }
  }

  check(id, condition, location, failure) {
    this.note(
      id,
      condition ? "pass" : "fail",
      location,
      condition ? "Requirement checked." : failure
    );
  }

  unknown(ids, location, detail) {
    for (const id of ids) {
      this.note(id, "unknown", location, detail);
    }
  }

  take(ids, location, depth) {
    if (this.visits < MAX_VISITS) {
      this.visits++;
      if (depth <= MAX_DEPTH) {
        return true;
      }
    }
    this.unknown(ids, location, "Document object traversal limit exceeded.");
    return false;
  }

  resolve(raw) {
    if (!(raw instanceof Ref)) {
      return raw;
    }
    try {
      const entry = this.xref.getEntry(raw.num);
      if (!entry || (entry.uncompressed ? entry.gen : 0) !== raw.gen) {
        return UNREADABLE;
      }
      const value = this.xref.fetch(raw);
      return isAbsent(value) || value === CIRCULAR_REF ? UNREADABLE : value;
    } catch (error) {
      if (error instanceof MissingDataException) {
        throw error;
      }
      return UNREADABLE;
    }
  }

  inspect(raw) {
    const path = referenceLocation("/Root", raw);
    const catalog = this.resolve(raw);
    if (catalog === UNREADABLE) {
      this.unknown(ALL_RULES, path, "Catalog reference could not be resolved.");
      return;
    }
    if (!(catalog instanceof Dict)) {
      this.check(
        "PDF-CATALOG",
        false,
        path,
        "Trailer /Root is not a catalog dictionary."
      );
      this.unknown(ALL_RULES, path, "No catalog dictionary to inspect.");
      return;
    }
    this.check(
      "PDF-CATALOG",
      raw instanceof Ref,
      path,
      "Trailer /Root is not an indirect reference."
    );
    this.requireName("PDF-CATALOG", catalog, "Type", "Catalog", path);
    const pages = catalog.getRaw("Pages");
    this.check(
      "PDF-CATALOG",
      pages instanceof Ref,
      `${path}/Pages`,
      "Catalog /Pages is not an indirect reference."
    );
    const pagesDict = this.resolve(pages);
    if (pagesDict === UNREADABLE) {
      this.unknown(
        ["PDF-CATALOG", ...PAGE_RULES],
        `${path}/Pages`,
        "Catalog /Pages reference could not be resolved."
      );
    } else if (!(pagesDict instanceof Dict)) {
      this.check(
        "PDF-CATALOG",
        false,
        `${path}/Pages`,
        "Catalog /Pages does not resolve to a dictionary."
      );
      this.unknown(PAGE_RULES, `${path}/Pages`, "No page tree to inspect.");
    } else {
      this.requireName(
        "PDF-CATALOG",
        pagesDict,
        "Type",
        "Pages",
        `${path}/Pages`
      );
      this.pageNode(pages, null, `${path}/Pages`, 0);
    }
    this.forbidActions("6.5.2-1", catalog, ["AA"], path);
    this.additionalActions(catalog, path);
    const open = catalog.getRaw("OpenAction");
    if (!isAbsent(open)) {
      const value = this.resolve(open);
      // A destination array is an alternative to an action dictionary.
      const destType = Array.isArray(value) && this.resolve(value[1]);
      if (!(destType instanceof Name && DESTINATIONS.has(destType.name))) {
        this.action(open, `${path}/OpenAction`);
      }
    }
    this.catalogNames(catalog.getRaw("Names"), `${path}/Names`);
    this.outlines(catalog.getRaw("Outlines"), `${path}/Outlines`);
    this.acroForm(catalog.getRaw("AcroForm"), `${path}/AcroForm`);
  }

  requireName(id, dict, key, expected, path) {
    const value = this.resolve(dict.getRaw(key));
    const location = `${path}/${key}`;
    if (value === UNREADABLE) {
      this.unknown(
        [id],
        location,
        "Required name reference could not be resolved."
      );
    } else {
      this.check(
        id,
        isName(value, expected),
        location,
        `Expected /${expected}.`
      );
    }
  }

  pageNode(raw, parent, path, depth) {
    path = referenceLocation(path, raw);
    if (!this.take(PAGE_RULES, path, depth)) {
      return null;
    }
    const dict = this.resolve(raw);
    if (dict === UNREADABLE) {
      this.unknown(
        PAGE_RULES,
        path,
        "Page tree reference could not be resolved."
      );
      return null;
    }
    if (!(dict instanceof Dict) || this.pageNodes.has(dict)) {
      this.check(
        "PDF-PAGE-TREE",
        false,
        path,
        "Page tree contains a non-dictionary, cycle or shared child."
      );
      this.unknown(
        PAGE_RULES,
        path,
        "The full page tree cannot be established."
      );
      return null;
    }
    this.pageNodes.add(dict);
    this.counts.pageTreeNodes++;
    const parentRef = dict.getRaw("Parent");
    this.check(
      "PDF-PAGE-TREE",
      isAbsent(parent) ? isAbsent(parentRef) : sameReference(parentRef, parent),
      `${path}/Parent`,
      "Page tree /Parent does not match its containing node."
    );
    const type = this.resolve(dict.getRaw("Type"));
    if (!isAbsent(parent) && isName(type, "Page")) {
      this.counts.pages++;
      this.forbidActions("6.5.2-2", dict, ["AA"], path);
      this.additionalActions(dict, path);
      this.pageAnnotations(dict.getRaw("Annots"), `${path}/Annots`);
      if (!isAbsent(dict.getRaw("PresSteps"))) {
        this.unknown(
          ACTION_RULES,
          `${path}/PresSteps`,
          "Presentation navigation is outside the inspected action paths."
        );
      }
      return 1;
    }
    if (!isName(type, "Pages")) {
      if (type !== UNREADABLE) {
        this.check(
          "PDF-PAGE-TREE",
          false,
          `${path}/Type`,
          "Unexpected page tree node type."
        );
      }
      this.unknown(
        PAGE_RULES,
        path,
        "Page tree node type does not establish its descendants."
      );
      return null;
    }
    const kids = this.resolve(dict.getRaw("Kids"));
    if (!Array.isArray(kids)) {
      if (kids !== UNREADABLE) {
        this.check(
          "PDF-PAGE-TREE",
          false,
          `${path}/Kids`,
          "Page tree /Kids is not an array."
        );
      }
      this.unknown(
        PAGE_RULES,
        `${path}/Kids`,
        "The page tree children could not be inspected."
      );
      return null;
    }
    let actual = 0;
    let complete = true;
    for (let i = 0; i < kids.length; i++) {
      const childPath = `${path}/Kids[${i}]`;
      if (this.visits >= MAX_VISITS) {
        this.unknown(
          PAGE_RULES,
          childPath,
          "Page tree traversal limit exceeded."
        );
        complete = false;
        break;
      }
      const child = kids[i];
      this.check(
        "PDF-PAGE-TREE",
        child instanceof Ref,
        childPath,
        "Page tree child is not an indirect reference."
      );
      const leaves = this.pageNode(child, raw, childPath, depth + 1);
      if (isAbsent(leaves)) {
        complete = false;
      } else {
        actual += leaves;
      }
    }
    const count = this.resolve(dict.getRaw("Count"));
    const countPath = `${path}/Count`;
    if (count === UNREADABLE || !complete) {
      this.unknown(
        ["PDF-PAGE-TREE"],
        countPath,
        "The full descendant page count could not be established."
      );
    } else {
      this.check(
        "PDF-PAGE-TREE",
        Number.isSafeInteger(count) && count === actual,
        countPath,
        "/Count does not equal the number of descendant pages."
      );
    }
    return complete ? actual : null;
  }

  pageAnnotations(raw, path) {
    if (isAbsent(raw)) {
      return;
    }
    const entries = this.resolve(raw);
    if (!Array.isArray(entries)) {
      if (entries !== UNREADABLE) {
        this.check(
          "PDF-ANNOTATION",
          false,
          path,
          "Page /Annots is not an array."
        );
      }
      this.unknown(
        [...ANNOTATION_RULES, ...ACTION_RULES],
        path,
        "The page annotations could not be inspected."
      );
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      const itemPath = `${path}[${i}]`;
      if (this.visits >= MAX_VISITS) {
        this.unknown(
          [...ANNOTATION_RULES, ...ACTION_RULES],
          itemPath,
          "Annotation traversal limit exceeded."
        );
        break;
      }
      this.check(
        "PDF-ANNOTATION",
        entries[i] instanceof Ref,
        itemPath,
        "Page /Annots item is not an indirect reference."
      );
      this.annotation(entries[i], itemPath);
    }
  }

  annotation(raw, path, depth = 0) {
    path = referenceLocation(path, raw);
    if (!this.take([...ANNOTATION_RULES, ...ACTION_RULES], path, depth)) {
      return;
    }
    const dict = this.resolve(raw);
    if (!(dict instanceof Dict)) {
      if (dict !== UNREADABLE) {
        this.check(
          "PDF-ANNOTATION",
          false,
          path,
          "Annotation is not a dictionary."
        );
      }
      this.unknown(
        [...ANNOTATION_RULES, ...ACTION_RULES],
        path,
        "Annotation could not be inspected."
      );
      return;
    }
    if (this.annotations.has(dict)) {
      return;
    }
    this.annotations.add(dict);
    this.counts.annotations++;
    const type = this.resolve(dict.getRaw("Type"));
    const subtype = this.resolve(dict.getRaw("Subtype"));
    if (type === UNREADABLE || subtype === UNREADABLE) {
      this.unknown(
        ["PDF-ANNOTATION"],
        path,
        "Annotation type information could not be resolved."
      );
    } else {
      this.check(
        "PDF-ANNOTATION",
        (isAbsent(type) || isName(type, "Annot")) && subtype instanceof Name,
        path,
        "Annotation has an invalid /Type or missing or invalid /Subtype."
      );
    }
    if (subtype === UNREADABLE) {
      this.unknown(
        ["6.3.1-1", "6.3.2-1", "6.3.3-1", "6.4.1-1"],
        path,
        "Annotation subtype could not be resolved."
      );
    } else {
      this.check(
        "6.3.1-1",
        subtype instanceof Name && ANNOTATIONS.has(subtype.name),
        `${path}/Subtype`,
        "Annotation type is not permitted in PDF/A-3."
      );
    }
    this.annotationFlags(dict, subtype, path);
    this.annotationAppearance(dict, subtype, path);
    if (isName(subtype, "Widget")) {
      this.forbidActions("6.4.1-1", dict, ["A", "AA"], path);
    }
    this.actionEntry(dict, "A", path);
    this.additionalActions(dict, path);
    const popup = dict.getRaw("Popup");
    if (!isAbsent(popup)) {
      this.annotation(popup, `${path}/Popup`, depth + 1);
    }
  }

  annotationFlags(dict, subtype, path) {
    const flags = this.resolve(dict.getRaw("F"));
    const location = `${path}/F`;
    if (flags === UNREADABLE) {
      this.unknown(
        ["PDF-ANNOTATION", "6.3.2-1", "6.3.2-2"],
        location,
        "Annotation flags could not be resolved."
      );
      return;
    }
    if (subtype instanceof Name && !isName(subtype, "Popup")) {
      this.check(
        "6.3.2-1",
        !isAbsent(flags),
        location,
        "Non-Popup annotation lacks /F."
      );
    }
    if (isAbsent(flags)) {
      return;
    }
    const integer =
      Number.isInteger(flags) && flags >= 0 && flags <= 0xffffffff;
    this.check(
      "PDF-ANNOTATION",
      integer,
      location,
      "Annotation flags are not an unsigned 32-bit integer."
    );
    if (!integer) {
      this.check(
        "6.3.2-2",
        false,
        location,
        "An invalid /F value cannot satisfy the required annotation flags."
      );
      return;
    }
    this.check(
      "6.3.2-2",
      (flags & 0x4) !== 0 && (flags & 0x123) === 0,
      location,
      "Print must be set and Invisible, Hidden, NoView and ToggleNoView must be clear."
    );
  }

  annotationAppearance(dict, subtype, path) {
    const rawRect = this.resolve(dict.getRaw("Rect"));
    const rect =
      Array.isArray(rawRect) && rawRect.length === 4
        ? rawRect.map(value => this.resolve(value))
        : null;
    const validRect = rect?.every(Number.isFinite);
    if (rawRect === UNREADABLE || rect?.includes(UNREADABLE)) {
      this.unknown(
        ["PDF-ANNOTATION"],
        `${path}/Rect`,
        "Annotation rectangle could not be resolved."
      );
    } else {
      this.check(
        "PDF-ANNOTATION",
        validRect,
        `${path}/Rect`,
        "Annotation /Rect is not a numeric rectangle."
      );
    }
    const appearance = this.resolve(dict.getRaw("AP"));
    const location = `${path}/AP`;
    const exempt =
      isName(subtype, "Popup") ||
      isName(subtype, "Link") ||
      (validRect && rect[0] === rect[2] && rect[1] === rect[3]);
    if (
      appearance === UNREADABLE ||
      (!exempt &&
        isAbsent(appearance) &&
        (!validRect || !(subtype instanceof Name)))
    ) {
      this.unknown(
        ["6.3.3-1"],
        location,
        "Appearance presence or its exemption could not be established."
      );
    } else if (!exempt) {
      this.check(
        "6.3.3-1",
        appearance instanceof Dict,
        location,
        "Annotation requires an appearance dictionary."
      );
    }
    if (appearance === UNREADABLE) {
      this.unknown(
        ["6.3.3-2"],
        location,
        "Appearance dictionary could not be resolved."
      );
    } else if (!isAbsent(appearance)) {
      this.normalAppearance(appearance, location);
    }
  }

  normalAppearance(appearance, location) {
    if (!(appearance instanceof Dict)) {
      this.check(
        "6.3.3-2",
        false,
        location,
        "/AP is not an appearance dictionary."
      );
      return;
    }
    const normal = this.resolve(appearance.getRaw("N"));
    if (isAbsent(normal)) {
      this.check("6.3.3-2", false, location, "Appearance dictionary lacks /N.");
      return;
    }
    let uncertain = normal === UNREADABLE;
    let count = 0;
    for (const [key, raw] of appearance.getRawEntries()) {
      if (++count > MAX_VISITS) {
        uncertain = true;
        break;
      }
      if (key === "N") {
        continue;
      }
      const value = this.resolve(raw);
      if (value === UNREADABLE) {
        uncertain = true;
      } else if (!isAbsent(value)) {
        this.check(
          "6.3.3-2",
          false,
          location,
          "Appearance dictionary must contain only /N."
        );
        return;
      }
    }
    if (uncertain) {
      this.unknown(
        ["6.3.3-2"],
        location,
        "Appearance entries could not all be resolved."
      );
    } else {
      this.check("6.3.3-2", true, location);
    }
  }

  forbidActions(id, dict, keys, path) {
    let uncertain = false;
    for (const key of keys) {
      const raw = dict.getRaw(key);
      const value = this.resolve(raw);
      if (value === UNREADABLE) {
        uncertain = true;
      } else if (!isAbsent(value)) {
        this.check(
          id,
          false,
          path + "/" + key,
          "Object contains a prohibited action entry."
        );
        return;
      }
    }
    if (uncertain) {
      this.unknown([id], path, "Action entry could not be resolved.");
    } else {
      this.check(id, true, path);
    }
  }

  actionEntry(dict, key, path) {
    const raw = dict.getRaw(key);
    if (!isAbsent(raw)) {
      this.action(raw, `${path}/${key}`);
    }
  }

  additionalActions(dict, path) {
    const raw = dict.getRaw("AA");
    if (isAbsent(raw)) {
      return;
    }
    const aaPath = referenceLocation(`${path}/AA`, raw);
    const aa = this.resolve(raw);
    if (!(aa instanceof Dict)) {
      this.unknown(
        ACTION_RULES,
        aaPath,
        "Additional-actions dictionary could not be inspected."
      );
      return;
    }
    let index = 0;
    for (const [key, value] of aa.getRawEntries()) {
      if (index >= MAX_VISITS || this.visits >= MAX_VISITS) {
        this.unknown(
          ACTION_RULES,
          aaPath,
          "Additional-actions traversal limit exceeded."
        );
        break;
      }
      if (!isAbsent(value)) {
        const label = /^[A-Z]{1,3}$/i.test(key) ? `/${key}` : `[${index}]`;
        this.action(value, aaPath + label);
      }
      index++;
    }
  }

  action(raw, path, depth = 0, active = new Set()) {
    path = referenceLocation(path, raw);
    if (!this.take(ACTION_RULES, path, depth)) {
      return;
    }
    const dict = this.resolve(raw);
    if (!(dict instanceof Dict) || active.has(dict)) {
      this.unknown(
        ACTION_RULES,
        path,
        "Action dictionary is unreadable or the action chain is cyclic."
      );
      return;
    }
    if (this.actions.has(dict)) {
      return;
    }
    this.actions.add(dict);
    active.add(dict);
    this.counts.actions++;
    const type = this.resolve(dict.getRaw("S"));
    if (type === UNREADABLE) {
      this.unknown(
        ACTION_RULES,
        `${path}/S`,
        "Action type could not be resolved."
      );
    } else {
      this.check(
        "6.5.1-1",
        type instanceof Name && ACTIONS.has(type.name),
        `${path}/S`,
        "Action type is missing or not permitted in PDF/A-3."
      );
    }
    if (isName(type, "Named")) {
      const name = this.resolve(dict.getRaw("N"));
      if (name === UNREADABLE) {
        this.unknown(
          ["6.5.1-2"],
          `${path}/N`,
          "Named action value could not be resolved."
        );
      } else {
        this.check(
          "6.5.1-2",
          name instanceof Name && NAMED_ACTIONS.has(name.name),
          `${path}/N`,
          "Named action is not a permitted page navigation action."
        );
      }
    }
    const next = dict.getRaw("Next");
    if (!isAbsent(next)) {
      const value = this.resolve(next);
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          if (this.visits >= MAX_VISITS) {
            this.unknown(
              ACTION_RULES,
              path,
              "Action-chain traversal limit exceeded."
            );
            break;
          }
          this.action(value[i], `${path}/Next[${i}]`, depth + 1, active);
        }
      } else {
        this.action(next, `${path}/Next`, depth + 1, active);
      }
    }
    active.delete(dict);
  }

  catalogNames(raw, path) {
    if (isAbsent(raw)) {
      return;
    }
    const names = this.resolve(raw);
    if (!(names instanceof Dict)) {
      this.unknown(
        ACTION_RULES,
        path,
        "The catalog name dictionary could not be inspected."
      );
      return;
    }
    if (!isAbsent(names.getRaw("AlternatePresentations"))) {
      this.unknown(
        ACTION_RULES,
        `${path}/AlternatePresentations`,
        "Alternate presentations are outside the inspected action paths."
      );
    }
    const js = names.getRaw("JavaScript");
    if (!isAbsent(js)) {
      this.nameTree(js, `${path}/JavaScript`, 0);
    }
  }

  nameTree(raw, path, depth) {
    path = referenceLocation(path, raw);
    if (!this.take(ACTION_RULES, path, depth)) {
      return;
    }
    const node = this.resolve(raw);
    if (!(node instanceof Dict) || this.nameNodes.has(node)) {
      this.unknown(
        ACTION_RULES,
        path,
        "JavaScript name tree is unreadable, repeated or cyclic."
      );
      return;
    }
    this.nameNodes.add(node);
    this.counts.nameTreeNodes++;
    const kids = this.resolve(node.getRaw("Kids"));
    const names = this.resolve(node.getRaw("Names"));
    if (
      (!isAbsent(kids) && !Array.isArray(kids)) ||
      (!isAbsent(names) && (!Array.isArray(names) || names.length % 2)) ||
      (isAbsent(kids) && isAbsent(names))
    ) {
      this.unknown(
        ACTION_RULES,
        path,
        "JavaScript name tree has an unsupported node shape."
      );
    }
    if (Array.isArray(kids)) {
      for (let i = 0; i < kids.length; i++) {
        if (this.visits >= MAX_VISITS) {
          this.unknown(
            ACTION_RULES,
            path,
            "JavaScript name-tree traversal limit exceeded."
          );
          break;
        }
        this.nameTree(kids[i], `${path}/Kids[${i}]`, depth + 1);
      }
    }
    if (Array.isArray(names)) {
      for (let i = 1; i < names.length; i += 2) {
        if (this.visits >= MAX_VISITS) {
          this.unknown(
            ACTION_RULES,
            path,
            "JavaScript name-tree traversal limit exceeded."
          );
          break;
        }
        const location = `${path}/Names[${i}]`;
        // The name tree defines document-level JavaScript actions. A
        // differently typed value is not evidence of a valid action path.
        const entry = this.resolve(names[i]);
        if (
          !(entry instanceof Dict) ||
          !isName(this.resolve(entry.getRaw("S")), "JavaScript")
        ) {
          this.unknown(
            ACTION_RULES,
            location,
            "Unexpected value in the JavaScript name tree."
          );
        }
        this.action(names[i], location);
      }
    }
  }

  outlines(raw, path) {
    if (isAbsent(raw)) {
      return;
    }
    const root = this.resolve(raw);
    if (!(root instanceof Dict)) {
      this.unknown(
        ACTION_RULES,
        path,
        "Outline dictionary could not be inspected."
      );
      return;
    }
    this.outlineChildren(root, path, 0);
  }

  outlineChildren(dict, path, depth) {
    let raw = dict.getRaw("First");
    let lastItem = null;
    let index = 0;
    while (!isAbsent(raw)) {
      const location = referenceLocation(`${path}/Items[${index++}]`, raw);
      if (!this.take(ACTION_RULES, location, depth)) {
        return;
      }
      const item = this.resolve(raw);
      if (!(item instanceof Dict) || this.outlineItems.has(item)) {
        this.unknown(
          ACTION_RULES,
          location,
          "Outline item is unreadable, repeated or cyclic."
        );
        return;
      }
      this.outlineItems.add(item);
      this.counts.outlineItems++;
      this.actionEntry(item, "A", location);
      this.outlineChildren(item, location, depth + 1);
      raw = item.getRaw("Next");
      lastItem = item;
    }
    const last = dict.getRaw("Last");
    if (
      (!isAbsent(last) || lastItem !== null) &&
      this.resolve(last) !== lastItem
    ) {
      this.unknown(
        ACTION_RULES,
        `${path}/Last`,
        "Outline endpoints do not identify the same traversable list."
      );
    }
  }

  acroForm(raw, path) {
    if (isAbsent(raw)) {
      return;
    }
    const form = this.resolve(raw);
    if (!(form instanceof Dict)) {
      this.unknown(
        ["6.4.1-2", "6.4.1-1", ...ACTION_RULES],
        path,
        "Interactive form dictionary could not be inspected."
      );
      return;
    }
    if (!isAbsent(form.getRaw("XFA"))) {
      this.unknown(
        ACTION_RULES,
        `${path}/XFA`,
        "XFA is outside the inspected action paths."
      );
    }
    this.fields(form.getRaw("Fields"), `${path}/Fields`, 0);
  }

  fields(raw, path, depth) {
    const rules = ["6.4.1-2", "6.4.1-1", ...ACTION_RULES];
    const fields = this.resolve(raw);
    if (!Array.isArray(fields)) {
      this.unknown(
        rules,
        path,
        "Interactive form field list could not be inspected."
      );
      return;
    }
    for (let i = 0; i < fields.length; i++) {
      const location = referenceLocation(`${path}[${i}]`, fields[i]);
      if (!this.take(rules, location, depth)) {
        return;
      }
      const field = this.resolve(fields[i]);
      if (!(field instanceof Dict) || this.formFields.has(field)) {
        this.unknown(
          rules,
          location,
          "Interactive field is unreadable, repeated or cyclic."
        );
        continue;
      }
      this.formFields.add(field);
      const widget = isName(this.resolve(field.getRaw("Subtype")), "Widget");
      // Separate widget-only children are annotation dictionaries, not fields.
      if (
        !widget ||
        depth === 0 ||
        !isAbsent(field.getRaw("T")) ||
        !isAbsent(field.getRaw("FT"))
      ) {
        this.counts.formFields++;
        this.forbidActions("6.4.1-2", field, ["A", "AA"], location);
      }
      if (widget) {
        this.annotation(fields[i], `${path}[${i}]`);
      } else {
        this.actionEntry(field, "A", location);
        this.additionalActions(field, location);
      }
      const kids = field.getRaw("Kids");
      if (!isAbsent(kids)) {
        this.fields(kids, `${location}/Kids`, depth + 1);
      }
    }
  }

  finish() {
    return {
      checks: ALL_RULES.map(
        id =>
          this.checks.get(id) || {
            id,
            status: "not-applicable",
            location: "",
            detail: "No applicable object in the inspected document graph.",
          }
      ),
      counts: this.counts,
    };
  }
}

function inspectPdfADocument(xref, trusted) {
  const inspection = new PdfADocumentInspection(xref);
  if (!trusted) {
    inspection.unknown(
      ALL_RULES,
      "/Root",
      "Recovered or incomplete cross-references cannot establish the effective document graph."
    );
  } else {
    inspection.inspect(xref.trailer.getRaw("Root"));
  }
  return inspection.finish();
}

export { inspectPdfADocument };
