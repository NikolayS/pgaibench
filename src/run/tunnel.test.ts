import { expect, test } from "bun:test";
import { tunnelArgs } from "./tunnel";

test("tunnel args forward each remote port to its local port", () => {
  const a = tunnelArgs("192.0.2.4", { 5432: 40001, 5433: 40002 });
  expect(a).toContain("-N");
  expect(a).toContain("ExitOnForwardFailure=yes");
  expect(a.join(" ")).toContain("-L 127.0.0.1:40001:127.0.0.1:5432 -L 127.0.0.1:40002:127.0.0.1:5433");
  expect(a.at(-1)).toBe("root@192.0.2.4");
});
