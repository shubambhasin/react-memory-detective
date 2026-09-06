import { beforeEach } from "vitest";
import { clearOwnerScope } from "../src/core/owner.js";

beforeEach(() => {
  clearOwnerScope();
});
