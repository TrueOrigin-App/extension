// Pins the shared not-the-rendered-image guard (imageMimeTypeFor): a
// declared image/* type is trusted, any other declared type is refused,
// and the no-declaration case resolves by magic-byte sniffing of the
// actual bytes — never by URL extension, which the review showed lets an
// HTML challenge page named photo.jpg masquerade as image/jpeg.

import { describe, expect, it } from "vitest";
import { imageMimeTypeFor } from "./image-accept";

const encoder = new TextEncoder();

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = encoder.encode("GIF89a");
const WEBP = new Uint8Array([
  ...encoder.encode("RIFF"),
  0x24,
  0x00,
  0x00,
  0x00,
  ...encoder.encode("WEBP"),
]);
const TIFF_LE = new Uint8Array([0x49, 0x49, 0x2a, 0x00]);
const TIFF_BE = new Uint8Array([0x4d, 0x4d, 0x00, 0x2a]);
const AVIF = new Uint8Array([
  0x00,
  0x00,
  0x00,
  0x1c,
  ...encoder.encode("ftypavif"),
]);
const HTML = encoder.encode(
  '<!DOCTYPE html><html><body><svg viewBox="0 0 1 1"></svg>Sign in</body></html>',
);

describe("imageMimeTypeFor", () => {
  it("trusts a declared image type, normalized and stripped of parameters", () => {
    expect(imageMimeTypeFor(HTML, "image/png")).toBe("image/png");
    expect(imageMimeTypeFor(HTML, "Image/JPEG; charset=utf-8")).toBe(
      "image/jpeg",
    );
  });

  it("refuses any declared non-image type", () => {
    for (const declared of [
      "text/html",
      "text/html;charset=utf-8",
      "application/json",
      "application/xml",
      "application/xhtml+xml",
    ]) {
      expect(() => imageMimeTypeFor(JPEG, declared)).toThrow(
        /not the rendered image/,
      );
    }
  });

  it("sniffs known image formats when no type is declared", () => {
    const cases: Array<[Uint8Array, string]> = [
      [JPEG, "image/jpeg"],
      [PNG, "image/png"],
      [GIF, "image/gif"],
      [WEBP, "image/webp"],
      [TIFF_LE, "image/tiff"],
      [TIFF_BE, "image/tiff"],
      [AVIF, "image/avif"],
    ];
    for (const [bytes, expected] of cases) {
      expect(imageMimeTypeFor(bytes, null)).toBe(expected);
      expect(imageMimeTypeFor(bytes, "")).toBe(expected);
    }
  });

  it("treats application/octet-stream as no declaration and sniffs", () => {
    expect(imageMimeTypeFor(PNG, "application/octet-stream")).toBe("image/png");
    expect(() => imageMimeTypeFor(HTML, "application/octet-stream")).toThrow(
      /MIME type/,
    );
  });

  it("recognizes SVG by document content, not by embedded <svg> tags", () => {
    expect(
      imageMimeTypeFor(encoder.encode('<svg xmlns="a"></svg>'), null),
    ).toBe("image/svg+xml");
    expect(
      imageMimeTypeFor(
        encoder.encode('<?xml version="1.0"?>\n<svg xmlns="a"></svg>'),
        null,
      ),
    ).toBe("image/svg+xml");
    // An HTML page embedding inline SVG icons must not pass: it starts as
    // an HTML document, and analyzing it would badge a login page.
    expect(() => imageMimeTypeFor(HTML, null)).toThrow(/MIME type/);
  });

  it("refuses undeclared bytes in no known image format", () => {
    expect(() => imageMimeTypeFor(encoder.encode("hello"), null)).toThrow(
      /MIME type/,
    );
    expect(() => imageMimeTypeFor(new Uint8Array(0), null)).toThrow(
      /MIME type/,
    );
  });
});
