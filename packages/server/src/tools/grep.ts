import { tool } from "ai";
import { relative, resolve } from "path";
import { z } from "zod";

/** Maximum number of grep matches returned to avoid overwhelming output. */
const MAX_MATCHES = 50;

/**
 * Creates an AI tool that searches file contents using grep.
 *
 * @param cwd - The working directory that acts as the project root.
 *              All search paths are resolved and validated relative to this directory.
 * @returns An AI tool that accepts a regex pattern, an optional subdirectory,
 *          and an optional file glob, then returns matching lines with their
 *          file paths and line numbers.
 */
export function createGrepTool(cwd: string) {
  return tool({
    description:
      "Search file contents using a regex pattern. Returns matching lines with file paths and line numbers. Skips hidden directories, node_modules, and binary files.",
    inputSchema: z.object({
      pattern: z.string().describe("Regex pattern to search for"),
      path: z
        .string()
        .describe("Relative directory to search in (defaults to project root)")
        .default("."),
      include: z
        .string()
        .describe("Glob pattern to filter files (e.g. '*.ts', '*.tsx')")
        .optional(),
    }),
    execute: async ({ pattern, path, include }) => {
      const resolved = resolve(cwd, path);

      // Prevent directory traversal attacks (e.g. ../../etc/passwd)
      if (!resolved.startsWith(cwd)) {
        return { error: "Path is outside the project directory" };
      }

      try {
        // Base grep flags:
        //   -r  recursive search
        //   -n  prefix each match with its line number
        //   --color=never  plain text output, no ANSI escape codes
        //   --exclude-dir  skip common non-source directories
        //   -E  use extended regular expressions
        const args = [
          "-rn",
          "--color=never",
          "--exclude-dir=node_modules",
          "--exclude-dir=.git",
          "-E",
        ];

        // Restrict search to files matching the provided glob pattern, if any.
        if (include) {
          args.push(`--include=${include}`);
        }

        args.push(pattern, resolved);

        const proc = Bun.spawn(["grep", ...args], {
          stdout: "pipe",
          stderr: "pipe",
          cwd,
        });

        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();

        await proc.exited;

        // grep exits with 1 when no matches are found — that is not an error.
        if (proc.exitCode !== 0 && proc.exitCode !== 1) {
          return { error: `grep failed: ${stderr.trim()}` };
        }

        if (!stdout.trim()) {
          return { matches: [], message: "No matches found" };
        }

        const lines = stdout.trim().split("\n");
        const matches: { file: string; line: number; content: string }[] = [];
        let truncated = false;

        for (const line of lines) {
          // Stop collecting once the cap is reached and flag the result as truncated.
          if (matches.length >= MAX_MATCHES) {
            truncated = true;
            break;
          }

          // Expected grep output format: /absolute/path/file:linenum:content
          const match = line.match(/^(.+?):(\d+):(.*)$/);
          if (match) {
            matches.push({
              file: relative(cwd, match[1]!), // Convert absolute path to project-relative path.
              line: parseInt(match[2]!, 10),
              content: match[3]!,
            });
          }
        }

        return {
          matches,
          // Include truncation metadata only when the result set was capped.
          ...(truncated ? { truncated: true, totalMatches: lines.length } : {}),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Failed to execute command: ${message}` };
      }
    },
  });
}
