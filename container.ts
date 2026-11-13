import type { BenchContainer } from "./bench.ts";
import { runCheck, type RunningCheck } from "./check.ts";

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * The shell command that copies the folder's tracked and untracked files, not the ignored ones, into a fresh
 * container of the set's image, copies the check files over them, and runs the check there; the container goes
 * when the check ends. Over ssh the engine runs on the host, and ending the ssh session ends the check.
 */
export function containerCommand(container: BenchContainer, checkFiles: string, command: string, folder: string): string {
  const engine = [
    ...(container.host === undefined ? [] : ["ssh", container.host]),
    container.engine,
    "run",
    "-i",
    "--rm",
    "-w",
    container.workdir,
    container.image,
    "sh",
    "-lc",
    `tar --ignore-zeros -xf - && ${command}`,
  ]
    .map(quote)
    .join(" ");
  return [
    "list=$(mktemp) || exit 1",
    `git -C ${quote(folder)} ls-files -z --cached --others --exclude-standard > "$list" &&`,
    `  { tar -C ${quote(folder)} --null -T "$list" -cf -; tar -C ${quote(checkFiles)} -cf - .; } | ${engine}`,
    "check_status=$?",
    'rm -f "$list"',
    'exit "$check_status"',
  ].join("\n");
}

/** The check in a fresh container, with runCheck's timeout and stop: ending the local process ends the run. */
export function runContainerCheck(
  container: BenchContainer,
  checkFiles: string,
  command: string,
  folder: string,
  options: { timeoutMs?: number; outputLimit?: number; graceMs?: number } = {},
): RunningCheck {
  return runCheck(containerCommand(container, checkFiles, command, folder), folder, options);
}
