import { hashStringValue } from "../analysis/ranges.js";

let nextObjectEpoch = 1;
const objectEpochs = new WeakMap<object, number>();

export function liveMdObjectEpoch(value: object): number {
  let epoch = objectEpochs.get(value);
  if (!epoch) {
    epoch = nextObjectEpoch++;
    objectEpochs.set(value, epoch);
  }
  return epoch;
}

export function liveMdValueEpoch(value: unknown): number {
  if (value == null) return 0;
  if (typeof value == "object" || typeof value == "function") {
    return liveMdObjectEpoch(value as object);
  }
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
    case "bigint":
    case "symbol":
      return hashStringValue(`${typeof value}:${primitiveEpochText(value)}`) || 1;
  }
  return 0;
}

export function liveMdCompositeEpoch(...values: readonly unknown[]): number {
  let epochs = values.map(liveMdValueEpoch);
  if (epochs.every((epoch) => epoch == 0)) return 0;
  return hashStringValue(keyParts(...epochs)) || 1;
}

function keyParts(...parts: readonly (number | string)[]) {
  return parts
    .map((part) => {
      let text = String(part);
      return `${text.length}:${text}`;
    })
    .join("|");
}

function primitiveEpochText(value: boolean | number | string | bigint | symbol) {
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return Number.isNaN(value) ? "NaN" : value.toString();
    case "string":
      return value;
    case "bigint":
      return value.toString();
    case "symbol":
      return value.description ?? "";
  }
}
