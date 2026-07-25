import { describe, it } from "node:test";
import assert from "node:assert";
import {
  resolveHttpConfig,
  defaultLoopbackAllowedHosts,
  defaultLoopbackAllowedOrigins,
} from "../dist/http-config.js";

describe("resolveHttpConfig", () => {
  it("throws when CALENDAR_TOKEN is missing", () => {
    assert.throws(
      () => resolveHttpConfig({}),
      /CALENDAR_TOKEN/,
    );
  });

  it("throws when CALENDAR_TOKEN is empty string", () => {
    assert.throws(
      () => resolveHttpConfig({ CALENDAR_TOKEN: "" }),
      /CALENDAR_TOKEN/,
    );
  });

  it("throws when MCP_HTTP_HOST is empty", () => {
    assert.throws(
      () => resolveHttpConfig({ CALENDAR_TOKEN: "t", MCP_HTTP_HOST: "" }),
      /MCP_HTTP_HOST/,
    );
  });

  describe("MCP_HTTP_PORT validation", () => {
    const invalid = [
      ["0", "below range"],
      ["65536", "above range"],
      ["+4500", "leading plus"],
      ["4500.5", "decimal"],
      [" 4500", "whitespace"],
      ["4e3", "exponent"],
      ["abc", "non-numeric"],
      ["", "empty"],
    ];

    for (const [val, label] of invalid) {
      it(`rejects "${val}" (${label})`, () => {
        assert.throws(
          () =>
            resolveHttpConfig({
              CALENDAR_TOKEN: "t",
              MCP_HTTP_PORT: val,
            }),
          /MCP_HTTP_PORT/,
        );
      });
    }

    const valid = [
      ["1", "minimum valid"],
      ["4500", "default"],
      ["65535", "maximum valid"],
    ];

    for (const [val, label] of valid) {
      it(`accepts "${val}" (${label})`, () => {
        const cfg = resolveHttpConfig({
          CALENDAR_TOKEN: "t",
          MCP_HTTP_PORT: val,
        });
        assert.strictEqual(cfg.port, Number.parseInt(val, 10));
      });
    }
  });

  it("throws when MCP_HTTP_ALLOWED_HOSTS is empty", () => {
    assert.throws(
      () =>
        resolveHttpConfig({
          CALENDAR_TOKEN: "t",
          MCP_HTTP_ALLOWED_HOSTS: "",
        }),
      /MCP_HTTP_ALLOWED_HOSTS/,
    );
  });

  it("throws when MCP_HTTP_ALLOWED_ORIGINS is empty", () => {
    assert.throws(
      () =>
        resolveHttpConfig({
          CALENDAR_TOKEN: "t",
          MCP_HTTP_ALLOWED_ORIGINS: "",
        }),
      /MCP_HTTP_ALLOWED_ORIGINS/,
    );
  });

  it("deduplicates and trims MCP_HTTP_ALLOWED_HOSTS", () => {
    const cfg = resolveHttpConfig({
      CALENDAR_TOKEN: "t",
      MCP_HTTP_ALLOWED_HOSTS: "  foo ,,bar , foo ,",
    });
    assert.deepStrictEqual(cfg.allowedHosts, ["foo", "bar"]);
  });

  it("deduplicates and trims MCP_HTTP_ALLOWED_ORIGINS", () => {
    const cfg = resolveHttpConfig({
      CALENDAR_TOKEN: "t",
      MCP_HTTP_ALLOWED_ORIGINS: "  http://a:* ,,http://b:* , http://a:* ,",
    });
    assert.deepStrictEqual(cfg.allowedOrigins, ["http://a:*", "http://b:*"]);
  });

  it("uses defaults when no HTTP variables are set", () => {
    const cfg = resolveHttpConfig({ CALENDAR_TOKEN: "test123" });
    assert.strictEqual(cfg.host, "127.0.0.1");
    assert.strictEqual(cfg.port, 4500);
    assert.deepStrictEqual(cfg.allowedHosts, [
      "127.0.0.1",
      "localhost",
      "[::1]",
    ]);
    assert.deepStrictEqual(cfg.allowedOrigins, [
      "http://127.0.0.1:*",
      "http://localhost:*",
      "http://[::1]:*",
    ]);
  });

  it("returns the configured values when all variables are set", () => {
    const cfg = resolveHttpConfig({
      CALENDAR_TOKEN: "secret",
      MCP_HTTP_HOST: "0.0.0.0",
      MCP_HTTP_PORT: "8080",
      MCP_HTTP_ALLOWED_HOSTS: "proxy.example.com",
      MCP_HTTP_ALLOWED_ORIGINS: "http://proxy.example.com:*",
    });
    assert.strictEqual(cfg.token, "secret");
    assert.strictEqual(cfg.host, "0.0.0.0");
    assert.strictEqual(cfg.port, 8080);
    assert.deepStrictEqual(cfg.allowedHosts, ["proxy.example.com"]);
    assert.deepStrictEqual(cfg.allowedOrigins, ["http://proxy.example.com:*"]);
  });
});

describe("defaultLoopbackAllowedHosts", () => {
  it("returns the three loopback hostnames", () => {
    assert.deepStrictEqual(defaultLoopbackAllowedHosts(), [
      "127.0.0.1",
      "localhost",
      "[::1]",
    ]);
  });
});

describe("defaultLoopbackAllowedOrigins", () => {
  it("returns the three loopback origins", () => {
    assert.deepStrictEqual(defaultLoopbackAllowedOrigins(), [
      "http://127.0.0.1:*",
      "http://localhost:*",
      "http://[::1]:*",
    ]);
  });
});