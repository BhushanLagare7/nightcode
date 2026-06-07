import { tool } from "ai";
import { readdir, stat } from "fs/promises";
import { join, relative, resolve } from "path";
import { z } from "zod";

/**
 * Creates a tool that lists files and directories within a given project directory.
 *
 * @param cwd - The absolute path to the project root, used as a security boundary
 *              to prevent directory traversal outside the project.
 * @returns A tool that accepts a relative path and returns a sorted list of entries
 *          with their types ("file" or "directory").
 */
export function createListDirectoryTool(cwd: string) {
  return tool({
    description:
      "List files and directories in a project directory. Returns names with type indicators.",
    inputSchema: z.object({
      path: z
        .string()
        .describe(
          "Relative path to the directory to list (defaults to project root)",
        )
        .default("."),
    }),
    execute: async ({ path }) => {
      // Resolve the target path relative to the project root
      const resolved = resolve(cwd, path);

      // Guard against directory traversal attacks
      if (!resolved.startsWith(cwd)) {
        return { error: "Path is outside the project directory" };
      }

      try {
        const entries = await readdir(resolved);
        const results: { name: string; type: "file" | "directory" }[] = [];

        for (const entry of entries) {
          // Skip hidden files (e.g. .git, .env) and large dependency directories
          if (entry.startsWith(".") || entry === "node_modules") continue;

          try {
            const entryPath = join(resolved, entry);
            const info = await stat(entryPath);
            results.push({
              name: entry,
              type: info.isDirectory() ? "directory" : "file",
            });
          } catch {
            // Skip entries we can't stat (e.g. broken symlinks, permission errors)
          }
        }

        // Sort directories before files, then alphabetically within each group
        results.sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

        return {
          path: relative(cwd, resolved) || ".",
          entries: results,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Failed to list directory: ${message}` };
      }
    },
  });
}
