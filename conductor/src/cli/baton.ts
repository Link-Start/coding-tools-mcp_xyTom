import { resolve } from "node:path";
import { formatBatonBundle, readBatonBundle } from "../baton/protocol.js";

export async function printBatonShow(path?: string): Promise<void> {
  const root = resolve(path ?? process.cwd());
  process.stdout.write(formatBatonBundle(await readBatonBundle(root)));
}
