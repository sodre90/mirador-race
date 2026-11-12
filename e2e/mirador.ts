import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Mirador's checkout, whose test host and helpers the specs use; by default it sits next to this one. */
export const miradorDir = process.env.MIRADOR_DIR ?? join(import.meta.dirname, "..", "..", "visualized-claude-sessions");
/** The plugin as the specs install it: scripts/e2e.sh copies it, so the owner's own Mirador never runs a test's copy. */
const pluginDir = process.env.RACE_PLUGIN_DIR ?? join(import.meta.dirname, "..");

type Helpers = typeof import("../../visualized-claude-sessions/e2e/helpers.ts");
type TestHostModule = typeof import("../../visualized-claude-sessions/e2e/test-host.ts");
export type TestHost = InstanceType<TestHostModule["TestHost"]>;

let loadedHelpers: Helpers | null = null;
export const helpers = () => {
  if (!loadedHelpers) throw new Error("Start the host first.");
  return loadedHelpers;
};

/**
 * A started Mirador test host with this plugin in its plugins folder, and an opencode stand-in that is an agent of its
 * own, taking prompts, writing each to `promptsFile`, and ending its turns at once.
 */
export async function startHostWithThisPlugin(): Promise<{ host: TestHost; promptsFile: string }> {
  const { TestHost, writeBunProgram } = (await import(join(miradorDir, "e2e", "test-host.ts"))) as TestHostModule;
  loadedHelpers = (await import(join(miradorDir, "e2e", "helpers.ts"))) as Helpers;
  const host = new TestHost({ fakePrograms: true });
  const promptsFile = join(host.root, "prompts");
  writeBunProgram(host.fakeProgramsDir, "opencode", join(miradorDir, "e2e", "fake-acp-agent.ts"), { FAKE_ACP_PROMPTS: promptsFile });
  writeFileSync(promptsFile, "");
  mkdirSync(join(host.dataDir, "plugins"), { recursive: true });
  symlinkSync(pluginDir, join(host.dataDir, "plugins", "race"));
  await host.start();
  return { host, promptsFile };
}
