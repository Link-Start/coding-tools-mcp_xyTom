import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli/index.ts"],
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
});
