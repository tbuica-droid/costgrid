/*
 * Rebuild the desktop app icons from the 1024 master.
 *
 *   npm --workspace @costgrid/desktop run build:icon
 *
 * The master is build/costgrid-app-icon-1024.png. The SVG beside it is the
 * same mark, kept for editing; this script resizes the PNG, not the SVG.
 *
 * Needs ImageMagick (`magick` or `convert`). The .icns is written by
 * `iconutil` on macOS, and by `png2icns` from icnsutils on Linux
 * (`apt install icnsutils`). An icns holds one element per pixel size, so
 * the @2x iconset files (which share pixels with the next 1x size) are
 * written into the iconset and only the unique sizes are passed to png2icns.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const buildDir = join(dirname(fileURLToPath(import.meta.url)), "..", "build");
const masterPath = join(buildDir, "costgrid-app-icon-1024.png");
const iconsetDir = join(buildDir, "icon.iconset");
const icnsPath = join(buildDir, "icon.icns");
const icoPath = join(buildDir, "icon.ico");
const pngPath = join(buildDir, "icon.png");
const sheetPath = join(buildDir, "icon-contact-sheet.png");

/** Apple iconset names and the pixel size of each file. */
const ICONSET = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

/**
 * One file per pixel size for png2icns. @2x files that repeat a size are
 * already in the iconset; an icns element cannot be stored twice.
 */
const ICNS_SOURCES = [
  ["icon_16x16.png", 16],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_256x256.png", 256],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

/** Sizes electron-builder accepts in a Windows .ico (256 is required). */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** OSType → pixel size for the icon elements macOS and png2icns write. Masks are listed separately. */
const ICON_TYPES = {
  icp4: 16,
  icp5: 32,
  icp6: 64,
  ic07: 128,
  ic08: 256,
  ic09: 512,
  ic10: 1024,
  ic11: 32,
  ic12: 64,
  ic13: 256,
  ic14: 512,
  is32: 16,
  il32: 32,
  ic04: 16,
  ic05: 32,
};
const MASK_BYTES = { s8mk: 16 * 16, l8mk: 32 * 32 };

const REQUIRED_SIZES = [16, 32, 64, 128, 256, 512, 1024];

function has(command) {
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function magickBin() {
  if (has("magick")) return "magick";
  if (has("convert")) return "convert";
  throw new Error("ImageMagick is required (magick or convert). On Debian/Ubuntu: apt install imagemagick");
}

function pngInfo(buf, label) {
  if (buf.length < 26 || buf.toString("ascii", 1, 4) !== "PNG") {
    throw new Error(`${label} is not a PNG`);
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
  };
}

function resize(bin, size, dest) {
  if (size === 1024) {
    copyFileSync(masterPath, dest);
    return;
  }
  execFileSync(bin, [masterPath, "-filter", "Lanczos", "-resize", `${size}x${size}`, `PNG32:${dest}`], {
    stdio: "inherit",
  });
  const info = pngInfo(readFileSync(dest), dest);
  if (info.width !== size || info.height !== size || info.colorType !== 6) {
    throw new Error(`${dest} is ${info.width}x${info.height} color type ${info.colorType}, expected ${size}x${size} RGBA`);
  }
}

function writeIco(images, dest) {
  const count = images.length;
  const header = Buffer.alloc(6 + count * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = header.length;
  const parts = [header];
  images.forEach((image, index) => {
    const at = 6 + index * 16;
    header[at] = image.size >= 256 ? 0 : image.size;
    header[at + 1] = image.size >= 256 ? 0 : image.size;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(image.buffer.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += image.buffer.length;
    parts.push(image.buffer);
  });
  writeFileSync(dest, Buffer.concat(parts));
}

function readIcoSizes(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    throw new Error("icon.ico is not an ICO file");
  }
  const count = buf.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const width = buf[at] || 256;
    const height = buf[at + 1] || 256;
    const bytes = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    const payload = buf.subarray(offset, offset + bytes);
    if (payload.length !== bytes || payload.toString("ascii", 1, 4) !== "PNG") {
      throw new Error(`icon.ico image ${i} is not a PNG payload`);
    }
    const info = pngInfo(payload, `icon.ico#${i}`);
    if (info.width !== width || info.height !== height) {
      throw new Error(`icon.ico directory says ${width}x${height} but the PNG is ${info.width}x${info.height}`);
    }
    sizes.push(width);
  }
  return sizes;
}

function parseIcns(buf) {
  if (buf.toString("ascii", 0, 4) !== "icns") throw new Error("icon.icns magic is not 'icns'");
  const declared = buf.readUInt32BE(4);
  if (declared !== buf.length) throw new Error(`icon.icns length is ${buf.length}, header says ${declared}`);
  const elements = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const type = buf.toString("ascii", offset, offset + 4);
    const length = buf.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > buf.length) throw new Error(`icon.icns chunk ${type} has an invalid length`);
    elements.push({ type, payload: buf.subarray(offset + 8, offset + length) });
    offset += length;
  }
  if (offset !== buf.length) throw new Error("icon.icns has trailing bytes");
  return elements;
}

function verifyIcns(buf) {
  const elements = parseIcns(buf);
  const present = new Set();
  for (const element of elements) {
    const maskBytes = MASK_BYTES[element.type];
    if (maskBytes !== undefined) {
      if (element.payload.length !== maskBytes) {
        throw new Error(`icon.icns mask ${element.type} is ${element.payload.length} bytes, expected ${maskBytes}`);
      }
      continue;
    }
    const size = ICON_TYPES[element.type];
    if (size === undefined) throw new Error(`icon.icns has an unknown element '${element.type}'`);
    if (element.payload.length === 0) throw new Error(`icon.icns element ${element.type} is empty`);
    if (element.payload[0] === 0x89) {
      const info = pngInfo(element.payload, element.type);
      if (info.width !== size || info.height !== size) {
        throw new Error(`icon.icns ${element.type} PNG is ${info.width}x${info.height}, expected ${size}`);
      }
    }
    present.add(size);
  }
  const missing = REQUIRED_SIZES.filter((size) => !present.has(size));
  if (missing.length > 0) throw new Error(`icon.icns is missing sizes: ${missing.join(", ")}`);
  return [...present].sort((a, b) => a - b);
}

/** PNG elements png2icns stores unchanged, and the iconset file they must match. */
const PNG_ELEMENT_FILE = {
  ic12: "icon_32x32@2x.png",
  ic07: "icon_128x128.png",
  ic08: "icon_256x256.png",
  ic09: "icon_512x512.png",
  ic10: "icon_512x512@2x.png",
};

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const stderr = (result.stderr ?? "")
    .split("\n")
    .filter((line) => line && !line.startsWith("libicns:"))
    .join("\n");
  if (result.stdout) process.stdout.write(result.stdout);
  if (stderr) process.stderr.write(`${stderr}\n`);
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
  return result.stdout ?? "";
}

function writeIcns() {
  if (process.platform === "darwin" && has("iconutil")) {
    run("iconutil", ["-c", "icns", iconsetDir, "-o", icnsPath]);
    return;
  }
  if (!has("png2icns")) {
    throw new Error("png2icns is required on Linux. On Debian/Ubuntu: apt install icnsutils");
  }
  run("png2icns", [icnsPath, ...ICNS_SOURCES.map(([name]) => join(iconsetDir, name))]);
  const elements = parseIcns(readFileSync(icnsPath));
  for (const element of elements) {
    const file = PNG_ELEMENT_FILE[element.type];
    if (file === undefined) continue;
    const source = readFileSync(join(iconsetDir, file));
    if (!element.payload.equals(source)) {
      throw new Error(`icon.icns ${element.type} does not match ${file}`);
    }
  }
  if (has("icns2png")) {
    const listed = run("icns2png", ["-l", icnsPath]);
    for (const size of REQUIRED_SIZES) {
      if (!listed.includes(`${size}x${size}`)) {
        throw new Error(`icns2png did not list ${size}x${size}`);
      }
    }
  }
}

function writeContactSheet(bin, cells) {
  const scratch = mkdtempSync(join(tmpdir(), "costgrid-icon-sheet-"));
  try {
    const tiles = cells.map((cell, index) => {
      const dest = join(scratch, `cell-${index}.png`);
      const filter = cell.size < 128 ? "Point" : "Lanczos";
      execFileSync(bin, [
        cell.file,
        "-filter",
        filter,
        "-resize",
        "112x112",
        "-background",
        "#141414",
        "-gravity",
        "center",
        "-extent",
        "168x128",
        "(",
        "-background",
        "#141414",
        "-fill",
        "#f3ead8",
        "-font",
        "DejaVu-Sans",
        "-pointsize",
        "14",
        "-gravity",
        "center",
        "-size",
        "168x48",
        `caption:${cell.size} px\n${cell.name.replace(".png", "")}`,
        ")",
        "-append",
        "-bordercolor",
        "#141414",
        "-border",
        "8",
        dest,
      ]);
      return dest;
    });
    const columns = 5;
    const rowFiles = [];
    for (let i = 0; i < tiles.length; i += columns) {
      const row = join(scratch, `row-${i}.png`);
      execFileSync(bin, [...tiles.slice(i, i + columns), "-background", "#141414", "+append", row]);
      rowFiles.push(row);
    }
    execFileSync(bin, [
      ...rowFiles,
      "-background",
      "#141414",
      "-append",
      "-bordercolor",
      "#141414",
      "-border",
      "24x20",
      `PNG32:${sheetPath}`,
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const master = readFileSync(masterPath);
const masterInfo = pngInfo(master, masterPath);
if (masterInfo.width !== 1024 || masterInfo.height !== 1024 || masterInfo.colorType !== 6) {
  throw new Error(`master must be 1024x1024 RGBA, got ${masterInfo.width}x${masterInfo.height} color type ${masterInfo.colorType}`);
}

const bin = magickBin();
mkdirSync(iconsetDir, { recursive: true });
for (const [name, size] of ICONSET) resize(bin, size, join(iconsetDir, name));
copyFileSync(masterPath, pngPath);

const scratch = mkdtempSync(join(tmpdir(), "costgrid-icon-"));
try {
  const icoImages = ICO_SIZES.map((size) => {
    const file = join(scratch, `${size}.png`);
    resize(bin, size, file);
    return { size, buffer: readFileSync(file) };
  });
  writeIco(icoImages, icoPath);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

writeIcns();
const sizes = verifyIcns(readFileSync(icnsPath));
const icoSizes = readIcoSizes(readFileSync(icoPath));
if (!icoSizes.includes(256)) throw new Error(`icon.ico sizes ${icoSizes.join(", ")} do not include 256`);

writeContactSheet(
  bin,
  ICONSET.map(([name, size]) => ({ name, size, file: join(iconsetDir, name) })),
);

console.log(`icon.icns sizes: ${sizes.join(", ")}`);
console.log(`icon.ico sizes: ${icoSizes.join(", ")}`);
console.log("wrote build/icon.iconset, icon.icns, icon.ico, icon.png, icon-contact-sheet.png");
