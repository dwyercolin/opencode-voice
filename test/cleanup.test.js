import assert from "node:assert/strict";
import test from "node:test";

import { parseListeningPorts } from "../lib/cleanup.js";

test("parses listening loopback ports from /proc/net/tcp format", () => {
  const proc = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:D7F8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0",
    "   1: 0100007F:0D48 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12346 1 0000000000000000 100 0 0 10 0",
    "   2: 00000000:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12347 1 0000000000000000 100 0 0 10 0",
  ].join("\n");
  // D7F8=55288, 0D48=3400, 1F40=8000
  assert.deepEqual(
    parseListeningPorts(proc).sort((a, b) => a - b),
    [3400, 8000, 55288],
  );
});

test("ignores non-listening sockets, remote hosts, and garbage lines", () => {
  const proc = [
    "header",
    "   0: 0100007F:D7F8 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 1 1 0", // ESTABLISHED
    "   1: 6C15EA9C:0D48 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2 1 0", // non-loopback
    "garbage line",
  ].join("\n");
  assert.deepEqual(parseListeningPorts(proc), []);
});

test("handles empty input", () => {
  assert.deepEqual(parseListeningPorts(""), []);
  assert.deepEqual(parseListeningPorts(null), []);
});
