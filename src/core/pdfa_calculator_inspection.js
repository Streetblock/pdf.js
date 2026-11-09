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

const OPERATORS = new Set(
  (
    "abs add atan ceiling cos cvi cvr div exp floor idiv ln log mod mul neg " +
    "round sin sqrt sub truncate and bitshift eq ge gt le lt ne not or xor " +
    "true false if ifelse copy dup exch index pop roll"
  ).split(" ")
);
const MIN_INT = -2147483648,
  MAX_INT = 2147483647;
const WHITE = new Set([0, 9, 10, 12, 13, 32]);
const NUMBER = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)$/;

class CalculatorFinding extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function unknown(detail) {
  throw new CalculatorFinding("unknown", detail);
}

function invalid(detail, certain = true) {
  throw new CalculatorFinding(certain ? "fail" : "unknown", detail);
}

function number(lower, upper, type = "real") {
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
    unknown("A numeric result could not be bounded finitely.");
  }
  return { kind: "number", lower, upper, type };
}

const boolean = value => ({ kind: "boolean", value });
const exact = value => value.lower === value.upper;

function parse(bytes) {
  if (bytes.length > 65536) {
    unknown("The calculator body exceeds the byte inspection limit.");
  }
  const tokens = [];
  for (let offset = 0; offset < bytes.length;) {
    const code = bytes[offset];
    if (WHITE.has(code)) {
      offset++;
      continue;
    }
    if (code === 37) {
      while (
        offset < bytes.length &&
        bytes[offset] !== 10 &&
        bytes[offset] !== 13
      ) {
        offset++;
      }
      continue;
    }
    if (tokens.length >= 4096) {
      unknown("The calculator body exceeds the token inspection limit.");
    }
    if (code === 123 || code === 125) {
      tokens.push(String.fromCharCode(code));
      offset++;
      continue;
    }
    const start = offset;
    while (
      offset < bytes.length &&
      !WHITE.has(bytes[offset]) &&
      ![37, 123, 125].includes(bytes[offset])
    ) {
      offset++;
    }
    const token = String.fromCharCode(...bytes.subarray(start, offset));
    if (NUMBER.test(token)) {
      const value = Number(token);
      let type = "real";
      if (!token.includes(".")) {
        if (!Number.isSafeInteger(value)) {
          unknown("The calculator integer literal exceeds exact inspection.");
        }
        type = value >= MIN_INT && value <= MAX_INT ? "int" : "mixed";
      }
      tokens.push(number(value, value, type));
    } else if (OPERATORS.has(token)) {
      tokens.push(token);
    } else {
      invalid("The calculator body contains a forbidden token or operator.");
    }
  }

  let index = 0;
  function block(depth) {
    if (depth > 24) {
      unknown("The calculator body exceeds the brace nesting limit.");
    }
    if (tokens[index++] !== "{") {
      invalid("Calculator expressions must be enclosed in braces.");
    }
    const nodes = [];
    while (index < tokens.length && tokens[index] !== "}") {
      const token = tokens[index];
      if (token === "{") {
        const yes = block(depth + 1);
        let no = [];
        if (tokens[index] === "{") {
          no = block(depth + 1);
          if (tokens[index++] !== "ifelse") {
            invalid("Two conditional blocks require ifelse.");
          }
        } else if (tokens[index++] !== "if") {
          invalid("A conditional block requires if.");
        }
        nodes.push({ kind: "conditional", yes, no });
      } else {
        if (token === "if" || token === "ifelse") {
          invalid(
            "A conditional operator requires its brace-delimited expressions."
          );
        }
        index++;
        nodes.push(token);
      }
    }
    if (tokens[index++] !== "}") {
      invalid("The calculator body contains unmatched braces.");
    }
    return nodes;
  }
  const result = block(0);
  if (index !== tokens.length) {
    invalid("Data follows the calculator's closing brace.");
  }
  return result;
}

class CalculatorInspection {
  pop(state) {
    if (!state.stack.length) {
      invalid("The calculator operand stack underflows.", state.certain);
    }
    return state.stack.pop();
  }

  numeric(value, state, integer = false) {
    if (integer && value.kind === "number" && value.type === "mixed") {
      unknown("The operand's integer type could not be established.");
    }
    if (value.kind !== "number" || (integer && value.type !== "int")) {
      invalid(
        "The calculator operator has an invalid operand type.",
        state.certain
      );
    }
    return value;
  }

  count(state) {
    const value = this.numeric(this.pop(state), state, true);
    if (!exact(value)) {
      unknown("A calculator stack count depends on its input.");
    }
    return value.lower;
  }

  run(nodes, states) {
    for (const node of nodes) {
      const next = [];
      for (const state of states) {
        if (this.operations-- <= 0) {
          unknown("The calculator operation inspection limit was reached.");
        }
        if (typeof node === "object" && node.kind === "conditional") {
          const condition = this.pop(state);
          if (condition.kind !== "boolean") {
            invalid(
              "A calculator conditional requires a Boolean.",
              state.certain
            );
          }
          if (condition.value === null) {
            if (++this.branches > 64) {
              unknown("The calculator branch inspection limit was reached.");
            }
            for (const body of [node.yes, node.no]) {
              next.push(
                ...this.run(body, [
                  { stack: state.stack.slice(), certain: false },
                ])
              );
            }
          } else {
            next.push(
              ...this.run(condition.value ? node.yes : node.no, [state])
            );
          }
        } else {
          this.step(node, state);
          if (state.stack.length > 128) {
            unknown("The calculator operand stack limit was reached.");
          }
          next.push(state);
        }
        if (next.length > 64) {
          unknown("The calculator branch inspection limit was reached.");
        }
      }
      states = next;
    }
    return states;
  }

  step(op, state) {
    const stack = state.stack;
    if (typeof op === "object") {
      stack.push(op);
      return;
    }
    if (op === "true" || op === "false") {
      stack.push(boolean(op === "true"));
      return;
    }
    if (["copy", "dup", "exch", "index", "pop", "roll"].includes(op)) {
      this.stackOperator(op, state);
      return;
    }
    if (
      [
        "abs",
        "neg",
        "ceiling",
        "floor",
        "round",
        "truncate",
        "cvi",
        "cvr",
        "sqrt",
        "ln",
        "log",
        "sin",
        "cos",
        "not",
      ].includes(op)
    ) {
      stack.push(this.unary(op, this.pop(state), state));
      return;
    }
    const right = this.pop(state);
    const left = this.pop(state);
    stack.push(this.binary(op, left, right, state));
  }

  stackOperator(op, state) {
    const stack = state.stack;
    if (op === "pop") {
      this.pop(state);
    } else if (op === "dup") {
      const value = this.pop(state);
      stack.push(value, value);
    } else if (op === "exch") {
      const right = this.pop(state),
        left = this.pop(state);
      stack.push(right, left);
    } else if (op === "index") {
      const count = this.count(state);
      if (count < 0 || count >= stack.length) {
        invalid(
          "The calculator index exceeds its operand stack.",
          state.certain
        );
      }
      stack.push(stack[stack.length - 1 - count]);
    } else {
      const shift = op === "roll" ? this.count(state) : 0;
      const count = this.count(state);
      if (count < 0 || count > stack.length) {
        invalid("The calculator stack count is out of range.", state.certain);
      }
      if (op === "copy") {
        stack.push(...stack.slice(stack.length - count));
      } else if (count) {
        const amount = ((shift % count) + count) % count;
        const values = stack.splice(stack.length - count);
        stack.push(
          ...values.slice(count - amount),
          ...values.slice(0, count - amount)
        );
      }
    }
  }

  unary(op, value, state) {
    if (op === "not") {
      if (value.kind === "boolean") {
        return boolean(value.value === null ? null : !value.value);
      }
      this.numeric(value, state, true);
      return exact(value)
        ? number(~value.lower, ~value.lower, "int")
        : number(MIN_INT, MAX_INT, "int");
    }
    this.numeric(value, state);
    const { lower, upper, type } = value;
    if (op === "cvr") {
      return number(lower, upper, "real");
    }
    if (op === "cvi") {
      if (Math.trunc(lower) < MIN_INT || Math.trunc(upper) > MAX_INT) {
        unknown("Integer conversion exceeds the proven integer range.");
      }
      return number(Math.trunc(lower), Math.trunc(upper), "int");
    }
    if (op === "abs") {
      return number(
        lower <= 0 && upper >= 0
          ? 0
          : Math.min(Math.abs(lower), Math.abs(upper)),
        Math.max(Math.abs(lower), Math.abs(upper)),
        this.arithmeticType(type, Math.max(Math.abs(lower), Math.abs(upper)))
      );
    }
    if (op === "neg") {
      return number(-upper, -lower, this.arithmeticType(type, -lower));
    }
    const rounding = {
      ceiling: Math.ceil,
      floor: Math.floor,
      round: Math.round,
      truncate: Math.trunc,
    };
    if (Object.hasOwn(rounding, op)) {
      return number(rounding[op](lower), rounding[op](upper), type);
    }
    if (op === "sin" || op === "cos") {
      return number(-1, 1);
    }
    const minimum = op === "sqrt" ? 0 : Number.MIN_VALUE;
    if (lower < minimum) {
      if (upper < minimum) {
        invalid(
          "The calculator mathematical operator has an invalid domain.",
          state.certain
        );
      }
      unknown("The calculator mathematical domain depends on its input.");
    }
    const operation = { sqrt: Math.sqrt, ln: Math.log, log: Math.log10 }[op];
    return number(operation(lower), operation(upper));
  }

  arithmeticType(type, upper, lower = upper) {
    if (type === "int" && (lower < MIN_INT || upper > MAX_INT)) {
      return "mixed";
    }
    return type;
  }

  binary(op, left, right, state) {
    if (["eq", "ne", "gt", "ge", "lt", "le"].includes(op)) {
      return this.compare(op, left, right, state);
    }
    if (["and", "or", "xor"].includes(op)) {
      if (left.kind === "boolean" && right.kind === "boolean") {
        if (left.value === null || right.value === null) {
          return boolean(null);
        }
        const a = left.value,
          b = right.value;
        const results = { and: a && b, or: a || b, xor: a !== b };
        return boolean(results[op]);
      }
      this.numeric(left, state, true);
      this.numeric(right, state, true);
      if (!exact(left) || !exact(right)) {
        return number(MIN_INT, MAX_INT, "int");
      }
      const a = left.lower,
        b = right.lower;
      const results = { and: a & b, or: a | b, xor: a ^ b };
      const result = results[op];
      return number(result, result, "int");
    }
    this.numeric(left, state, ["mod", "idiv", "bitshift"].includes(op));
    this.numeric(right, state, ["mod", "idiv", "bitshift"].includes(op));
    if (op === "bitshift") {
      if (!exact(left) || !exact(right)) {
        return number(MIN_INT, MAX_INT, "int");
      }
      const amount = right.lower;
      let result = 0;
      if (Math.abs(amount) < 32) {
        result = amount >= 0 ? left.lower << amount : left.lower >>> -amount;
      }
      const signed = result | 0;
      return number(signed, signed, "int");
    }
    if (op === "atan") {
      if (!exact(left) || !exact(right)) {
        unknown("The angle operation depends on its input.");
      }
      if (!left.lower && !right.lower) {
        invalid(
          "atan is undefined when both operands are zero.",
          state.certain
        );
      }
      const result =
        ((Math.atan2(left.lower, right.lower) * 180) / Math.PI + 360) % 360;
      return number(result, result);
    }
    if (op === "exp") {
      if (!exact(right)) {
        unknown("A variable exponent is outside the supported proof.");
      }
      const exponent = right.lower;
      if (
        (!Number.isInteger(exponent) && left.lower < 0) ||
        (exponent < 0 && left.lower <= 0 && left.upper >= 0)
      ) {
        if (exact(left)) {
          invalid("The exponentiation has an invalid domain.", state.certain);
        }
        unknown("The exponentiation domain depends on its input.");
      }
      const values = [left.lower ** exponent, left.upper ** exponent];
      if (left.lower <= 0 && left.upper >= 0 && exponent > 0) {
        values.push(0);
      }
      return number(Math.min(...values), Math.max(...values));
    }
    const a = [left.lower, left.upper],
      b = [right.lower, right.upper];
    if (["div", "idiv", "mod"].includes(op)) {
      if (right.lower === 0 && right.upper === 0) {
        invalid("The calculator divides by zero.", state.certain);
      }
      if (right.lower <= 0 && right.upper >= 0) {
        unknown("A possible zero divisor cannot be excluded.");
      }
      if (op === "mod") {
        const magnitude =
          Math.max(Math.abs(right.lower), Math.abs(right.upper)) - 1;
        return number(
          left.lower < 0 ? -magnitude : 0,
          left.upper > 0 ? magnitude : 0,
          "int"
        );
      }
    }
    if (op === "sub" && left === right) {
      return number(0, 0, left.type);
    }
    const operations = {
      add: (x, y) => x + y,
      sub: (x, y) => x - y,
      mul: (x, y) => x * y,
      div: (x, y) => x / y,
      idiv: (x, y) => Math.trunc(x / y),
    };
    const operation = operations[op];
    if (!operation) {
      unknown("The operator is outside the supported numeric proof.");
    }
    const values = a.flatMap(x => b.map(y => operation(x, y)));
    const lower = Math.min(...values),
      upper = Math.max(...values);
    if (op === "idiv" && (lower < MIN_INT || upper > MAX_INT)) {
      unknown("The integer quotient exceeds the proven integer range.");
    }
    let operandType = "mixed";
    if (left.type === "real" || right.type === "real" || op === "div") {
      operandType = "real";
    } else if (left.type === "int" && right.type === "int") {
      operandType = "int";
    }
    const type = this.arithmeticType(operandType, upper, lower);
    return number(lower, upper, type);
  }

  compare(op, left, right, state) {
    let result = null;
    if (op === "eq" || op === "ne") {
      if (left.kind !== right.kind) {
        result = false;
      } else if (left === right) {
        result = true;
      } else if (left.kind === "boolean") {
        if (left.value !== null && right.value !== null) {
          result = left.value === right.value;
        }
      } else if (exact(left) && exact(right)) {
        result = left.lower === right.lower;
      } else if (left.upper < right.lower || right.upper < left.lower) {
        result = false;
      }
      return boolean(op === "ne" && result !== null ? !result : result);
    }
    this.numeric(left, state);
    this.numeric(right, state);
    if (op === "gt" || op === "ge") {
      [left, right] = [right, left];
      op = op === "gt" ? "lt" : "le";
    }
    if (op === "lt") {
      if (left.upper < right.lower) {
        result = true;
      } else if (left.lower >= right.upper) {
        result = false;
      }
    } else if (left.upper <= right.lower) {
      result = true;
    } else if (left.lower > right.upper) {
      result = false;
    }
    return boolean(result);
  }

  operations = 8192;

  branches = 0;
}

function inspectCalculator(bytes, domain) {
  try {
    const nodes = parse(bytes);
    if (
      !domain ||
      domain.length !== 2 ||
      !domain.every(Number.isFinite) ||
      domain[0] > domain[1]
    ) {
      return {
        status: "unknown",
        detail: "The calculator input domain could not be established.",
      };
    }
    const inspection = new CalculatorInspection();
    const states = inspection.run(nodes, [
      { stack: [number(domain[0], domain[1])], certain: true },
    ]);
    for (const state of states) {
      if (state.stack.length !== 1 || state.stack[0].kind !== "number") {
        invalid(
          "The calculator must leave exactly one numeric output.",
          state.certain
        );
      }
    }
    return {
      status: "pass",
      detail:
        "Calculator syntax and one finite numeric output were proven within the inspected domain.",
    };
  } catch (error) {
    if (error instanceof CalculatorFinding) {
      return { status: error.status, detail: error.message };
    }
    return {
      status: "unknown",
      detail: "The calculator body could not be fully inspected.",
    };
  }
}

export { inspectCalculator };
