import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = packageRootArg() ?? path.join(root, "vendor/web-tree-sitter");

const wasmFiles = ["web-tree-sitter.wasm", "debug/web-tree-sitter.wasm"];

for (let file of wasmFiles) {
  let absolute = path.join(packageRoot, file);
  await writeFile(absolute, patchWasm(await readFile(absolute), file));
}

function packageRootArg() {
  let index = process.argv.indexOf("--package-root");
  if (index == -1) return null;
  let value = process.argv[index + 1];
  if (!value) throw new Error("--package-root requires a path");
  return path.resolve(value);
}

function patchWasm(buffer, label) {
  if (buffer.readUInt32LE(0) != 0x6d736100 || buffer.readUInt32LE(4) != 1) {
    throw new Error(`${label}: not a WebAssembly module`);
  }

  let offset = 8;
  let sections = [];
  while (offset < buffer.length) {
    let id = buffer[offset++];
    let size = readU32(buffer, offset);
    offset = size.next;
    let start = offset;
    let end = start + size.value;
    sections.push({ id, headerStart: size.headerStart - 1, start, end });
    offset = end;
  }

  let importFunctionCount = countImportedFunctions(requiredSection(sections, 2, label), buffer);
  let exports = readExports(requiredSection(sections, 7, label), buffer);
  let indexFunction = exports.get("ts_tree_cursor_goto_first_child_for_index_wasm");
  let positionFunction = exports.get("ts_tree_cursor_goto_first_child_for_position_wasm");
  if (indexFunction == null || positionFunction == null) {
    throw new Error(`${label}: missing cursor range exports`);
  }

  let codeSection = requiredSection(sections, 10, label);
  let bodies = readCodeBodies(codeSection, buffer);
  bodies[indexFunction - importFunctionCount] = patchIndexBody(
    bodies[indexFunction - importFunctionCount],
    label,
  );
  bodies[positionFunction - importFunctionCount] = patchPositionBody(
    bodies[positionFunction - importFunctionCount],
    label,
  );

  let codePayload = concat([
    writeU32(bodies.length),
    ...bodies.map((body) => concat([writeU32(body.length), body])),
  ]);
  let chunks = [];
  let previousEnd = 0;
  for (let section of sections) {
    chunks.push(buffer.subarray(previousEnd, section.headerStart));
    if (section == codeSection) {
      chunks.push(Buffer.from([section.id]), writeU32(codePayload.length), codePayload);
    } else {
      chunks.push(buffer.subarray(section.headerStart, section.end));
    }
    previousEnd = section.end;
  }
  chunks.push(buffer.subarray(previousEnd));
  return concat(chunks);
}

function patchIndexBody(body, label) {
  body = replaceBytesEither(
    body,
    [
      {
        from: [0x20, 0x01, 0x41, 0x0c, 0x6a, 0x20, 0x02, 0x41, 0x01, 0x74, 0x41, 0x00, 0x41, 0x00],
        to: [
          0x20, 0x01, 0x41, 0x0c, 0x6a, 0x20, 0x00, 0x28, 0x02, 0x10, 0x41, 0x01, 0x74, 0x41, 0x00,
          0x41, 0x00,
        ],
      },
      { from: [0x20, 0x03, 0x41, 0x0c, 0x6a], to: [0x20, 0x03, 0x41, 0x10, 0x6a] },
    ],
    `${label}: index goal offset`,
  );
  return replaceBytesOnce(body, [0x42, 0x00, 0x52], [0x42, 0x7f, 0x52], `${label}: index return`);
}

function patchPositionBody(body, label) {
  body = replaceBytesEither(
    body,
    [
      {
        from: [
          0x20, 0x01, 0x20, 0x00, 0x28, 0x02, 0x10, 0x41, 0x01, 0x74, 0x36, 0x02, 0x18, 0x20, 0x01,
          0x20, 0x02, 0x36, 0x02, 0x14,
        ],
        to: [
          0x20, 0x01, 0x20, 0x00, 0x28, 0x02, 0x14, 0x41, 0x01, 0x74, 0x36, 0x02, 0x18, 0x20, 0x01,
          0x20, 0x00, 0x28, 0x02, 0x10, 0x36, 0x02, 0x14,
        ],
      },
      { from: [0x20, 0x03, 0x41, 0x0c, 0x6a], to: [0x20, 0x03, 0x41, 0x10, 0x6a] },
    ],
    `${label}: position goal offset`,
  );
  return replaceBytesOnce(
    body,
    [0x42, 0x00, 0x52],
    [0x42, 0x7f, 0x52],
    `${label}: position return`,
  );
}

function readCodeBodies(section, buffer) {
  let offset = section.start;
  let count = readU32(buffer, offset);
  offset = count.next;
  let bodies = [];
  for (let i = 0; i < count.value; i++) {
    let size = readU32(buffer, offset);
    offset = size.next;
    bodies.push(buffer.subarray(offset, offset + size.value));
    offset += size.value;
  }
  if (offset != section.end) throw new Error("code section size mismatch");
  return bodies;
}

function countImportedFunctions(section, buffer) {
  let offset = section.start;
  let count = readU32(buffer, offset);
  offset = count.next;
  let functions = 0;
  for (let i = 0; i < count.value; i++) {
    offset = skipName(buffer, offset);
    offset = skipName(buffer, offset);
    let kind = buffer[offset++];
    if (kind == 0) {
      functions++;
      offset = readU32(buffer, offset).next;
    } else if (kind == 1) {
      offset = skipTableType(buffer, offset);
    } else if (kind == 2) {
      offset = skipLimits(buffer, offset);
    } else if (kind == 3) {
      offset += 2;
    } else {
      throw new Error(`unknown import kind ${kind}`);
    }
  }
  return functions;
}

function readExports(section, buffer) {
  let offset = section.start;
  let count = readU32(buffer, offset);
  offset = count.next;
  let exports = new Map();
  for (let i = 0; i < count.value; i++) {
    let name = readName(buffer, offset);
    offset = name.next;
    let kind = buffer[offset++];
    let index = readU32(buffer, offset);
    offset = index.next;
    if (kind == 0) exports.set(name.value, index.value);
  }
  return exports;
}

function requiredSection(sections, id, label) {
  let section = sections.find((entry) => entry.id == id);
  if (!section) throw new Error(`${label}: missing section ${id}`);
  return section;
}

function skipName(buffer, offset) {
  let size = readU32(buffer, offset);
  return size.next + size.value;
}

function readName(buffer, offset) {
  let size = readU32(buffer, offset);
  let start = size.next;
  return {
    value: buffer.subarray(start, start + size.value).toString("utf8"),
    next: start + size.value,
  };
}

function skipTableType(buffer, offset) {
  return skipLimits(buffer, offset + 1);
}

function skipLimits(buffer, offset) {
  let flags = buffer[offset++];
  offset = readU32(buffer, offset).next;
  if (flags & 1) offset = readU32(buffer, offset).next;
  return offset;
}

function readU32(buffer, start) {
  let result = 0;
  let shift = 0;
  let offset = start;
  for (;;) {
    let byte = buffer[offset++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) == 0) return { value: result >>> 0, next: offset, headerStart: start };
    shift += 7;
  }
}

function writeU32(value) {
  let bytes = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
}

function replaceBytesOnce(buffer, from, to, label) {
  let matches = [];
  for (let index = 0; index <= buffer.length - from.length; index++) {
    let matched = true;
    for (let i = 0; i < from.length; i++) {
      if (buffer[index + i] != from[i]) {
        matched = false;
        break;
      }
    }
    if (matched) matches.push(index);
  }
  if (matches.length !== 1)
    throw new Error(`${label}: expected one byte match, saw ${matches.length}`);
  let index = matches[0];
  return concat([buffer.subarray(0, index), Buffer.from(to), buffer.subarray(index + from.length)]);
}

function replaceBytesEither(buffer, replacements, label) {
  let errors = [];
  for (let replacement of replacements) {
    try {
      return replaceBytesOnce(buffer, replacement.from, replacement.to, label);
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(`${label}: no supported byte pattern matched (${errors.join("; ")})`);
}

function concat(chunks) {
  return Buffer.concat(chunks);
}
