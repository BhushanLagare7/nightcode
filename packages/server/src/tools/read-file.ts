import { tool } from "ai";
import { readFile } from "fs/promises";
import { relative, resolve } from "path";
import { z } from "zod";

const MAX_FILE_SIZE = 10_000;

/**
 * Creates an AI tool that reads file contents from the project directory.
 *
 * @param cwd - The working directory that acts as the project root.
 *              All file paths are resolved and validated relative to this directory.
 * @returns An AI tool that accepts a file path, reads the file, and returns
 *          its content. Very large files are truncated to ${MAX_FILE_SIZE} bytes.
 */
export function createReadFileTool(cwd: string) {
  return tool({
    description:
      "Read the contents of a file in the project. Returns the file text, truncated if very large.",
    inputSchema: z.object({
      path: z.string().describe("Relative path to the file to read"),
    }),
    execute: async ({ path }) => {
      const resolved = resolve(cwd, path);
      const rel = relative(cwd, resolved);

      if (
        rel.startsWith("..") ||
        (resolve(resolved) !== resolved && rel.startsWith(".."))
      ) {
        return { error: "Path is outside the project directory" };
      }

      // Ensure resolved path is still within cwd
      if (!resolved.startsWith(cwd)) {
        return { error: "Path is outside the project directory" };
      }

      try {
        const content = await readFile(resolved, "utf-8");
        if (content.length > MAX_FILE_SIZE) {
          return {
            content: content.slice(0, MAX_FILE_SIZE),
            truncated: true,
            totalLength: content.length,
          };
        }
        return { content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Failed to read file: ${message}` };
      }
    },
  });
}
