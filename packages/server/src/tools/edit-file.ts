import { tool } from "ai";
import { readFile, writeFile } from "fs/promises";
import { relative, resolve } from "path";
import { z } from "zod";

/**
 * Creates a tool that performs targeted string replacement edits on a file.
 * Requires the target string to appear exactly once to prevent unintended changes.
 *
 * @param cwd - The working directory used to resolve and validate file paths
 */
export function createEditFileTool(cwd: string) {
  return tool({
    description:
      "Make a targeted edit to a file by replacing an exact string match. The oldString must appear exactly once in the file (for safety). Use this for surgical edits instead of rewriting entire files.",
    inputSchema: z.object({
      path: z.string().describe("Relative path to the file to edit"),
      oldString: z
        .string()
        .describe(
          "The exact text to find and replace (must be unique in the file)",
        ),
      newString: z.string().describe("The text to replace it with"),
    }),
    execute: async ({ path, oldString, newString }) => {
      const resolved = resolve(cwd, path);

      // Prevent directory traversal attacks (e.g. ../../etc/passwd)
      if (!resolved.startsWith(cwd)) {
        return { error: "Path is outside the project directory" };
      }

      try {
        // Read the file at the resolved path
        const content = await readFile(resolved, "utf-8");

        // Count occurrences to ensure the replacement target is unambiguous
        const occurrences = content.split(oldString).length - 1;

        if (occurrences === 0) {
          return { error: "oldString not found in file" };
        }

        if (occurrences > 1) {
          return {
            error: `oldString is ambiguous — found ${occurrences} matches. Provide more surrounding context to make it unique.`,
          };
        }

        // Perform the string replacement
        const updated = content.replace(oldString, newString);

        // Write the updated content back to the file
        await writeFile(resolved, updated, "utf-8");

        return {
          success: true as const,
          // Return a relative path to avoid exposing absolute server paths
          path: relative(cwd, resolved),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Failed to edit file: ${message}` };
      }
    },
  });
}
