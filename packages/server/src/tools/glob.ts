import { tool } from "ai";
import { relative, resolve } from "path";
import { z } from "zod";

/** Maximum number of file results to return before truncating */
const MAX_RESULTS = 200;

/**
 * Creates a glob file search tool scoped to the given working directory.
 * @param cwd - Absolute path to the project root directory
 */
export function createGlobTool(cwd: string) {
  return tool({
    description:
      "Find files matching a glob pattern. Returns file paths relative to the project root. Skips node_modules and hidden directories.",
    inputSchema: z.object({
      pattern: z
        .string()
        .describe("Glob pattern to match (e.g. '**/*.ts', 'src/**/*.tsx')"),
      path: z
        .string()
        .describe("Relative directory to search in (defaults to project root)")
        .default("."),
    }),
    execute: async ({ pattern, path }) => {
      const resolved = resolve(cwd, path);

      // Prevent directory traversal attacks (e.g. ../../etc/passwd)
      if (!resolved.startsWith(cwd)) {
        return { error: "Path is outside the project directory" };
      }

      try {
        const glob = new Bun.Glob(pattern);
        const files: string[] = [];
        let truncated = false;

        for await (const match of glob.scan({
          cwd: resolved,
          dot: false, // Exclude hidden files and directories
          onlyFiles: true, // Exclude directories from results
        })) {
          // Skip any matches inside node_modules
          if (match.includes("node_modules")) continue;

          // Stop collecting results once the limit is reached
          if (files.length >= MAX_RESULTS) {
            truncated = true;
            break;
          }

          // Convert each match to a path relative to the project root
          const absoluteMatch = resolve(resolved, match);
          files.push(relative(cwd, absoluteMatch));
        }

        // Sort the results alphabetically for consistent ordering
        files.sort();

        return {
          files,
          // Only include the truncated flag when the result set was cut off
          ...(truncated ? { truncated: true } : {}),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Failed to search for files: ${message}` };
      }
    },
  });
}
