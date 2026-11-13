import { randomUUID } from "node:crypto";
import type { BenchContainer } from "./bench.ts";
import { runCheck, type RunningCheck } from "./check.ts";

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** ssh joins its arguments into one line the remote shell reads again, so the engine's command goes as one quoted word. */
const onHost = (container: BenchContainer, ...args: string[]) => {
  const command = args.map(quote).join(" ");
  return container.host === undefined ? command : `ssh ${quote(container.host)} ${quote(command)}`;
};

/**
 * The shell command that packs the folder's tracked and untracked files, not the ignored ones, with the check files
 * over them, into one archive; unpacks it in a fresh container of the set's image; and runs the check there. The
 * container goes when the check ends, and is removed by name when the check is stopped, here or over ssh.
 */
export function containerCommand(container: BenchContainer, checkFiles: string, command: string, folder: string, name = `mirador-check-${randomUUID().slice(0, 8)}`): string {
  const run = onHost(container, container.engine, "run", "-i", "--rm", "--sig-proxy=false", "--name", name, "-w", container.workdir, container.image, "sh", "-lc", `tar -xf - && ${command}`);
  const remove = onHost(container, container.engine, "rm", "-f", name);
  return [
    "list=$(mktemp) && archive=$(mktemp) || exit 1",
    `remove_container() { ${remove} > /dev/null 2>&1; rm -f "$list" "$archive"; }`,
    "trap 'remove_container; exit 143' TERM",
    "export COPYFILE_DISABLE=1",
    `git -C ${quote(folder)} ls-files -z --cached --others --exclude-standard > "$list" &&`,
    `  tar -C ${quote(folder)} --null -T "$list" -cf "$archive" &&`,
    `  tar -C ${quote(checkFiles)} -rf "$archive" . || { remove_container; exit 1; }`,
    `${run} < "$archive" &`,
    'wait "$!"',
    "check_status=$?",
    "remove_container",
    'exit "$check_status"',
  ].join("\n");
}

/** The check in a fresh container, with runCheck's timeout and stop: ending the local process removes the container. */
export function runContainerCheck(
  container: BenchContainer,
  checkFiles: string,
  command: string,
  folder: string,
  options: { timeoutMs?: number; outputLimit?: number; graceMs?: number } = {},
): RunningCheck {
  return runCheck(containerCommand(container, checkFiles, command, folder), folder, options);
}
