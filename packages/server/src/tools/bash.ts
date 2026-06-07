import { tool } from "ai";
import { z } from "zod";

/** Maximum number of characters to capture from stdout/stderr before truncating. */
const MAX_OUTPUT = 20_000;

/** Default command execution timeout in milliseconds. */
const DEFAULT_TIMEOUT = 30_000;

/**
 * Creates a bash tool that executes shell commands in the specified working directory.
 *
 * @param cwd - The working directory in which commands will be executed.
 * @returns A tool instance configured to run bash commands.
 */
export function createBashTool(cwd: string) {
  return tool({
    description:
      "Execute a shell command in the project directory. Use this for running tests, builds, git operations, package installs, and any other shell commands.",
    inputSchema: z.object({
      command: z.string().describe("The shell command to execute"),
      timeout: z
        .number()
        .describe("Timeout in milliseconds (default: 30000)")
        .default(DEFAULT_TIMEOUT),
    }),
    execute: async ({ command, timeout }) => {
      try {
        // Spawn a bash process with piped stdout/stderr and a minimal terminal environment.
        const proc = Bun.spawn(["bash", "-c", command], {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, TERM: "dumb" },
        });

        // Kill the process if it exceeds the specified timeout.
        const timer = setTimeout(() => {
          proc.kill();
        }, timeout);

        // Collect stdout and stderr concurrently.
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);

        const exitCode = await proc.exited;
        clearTimeout(timer);

        // Truncate output that exceeds MAX_OUTPUT to avoid overwhelming the response.
        const truncate = (s: string) =>
          s.length > MAX_OUTPUT
            ? s.slice(0, MAX_OUTPUT) +
              `\n... (truncated, ${s.length} total chars)`
            : s;

        return {
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          exitCode,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Failed to execute command: ${message}` };
      }
    },
  });
}
