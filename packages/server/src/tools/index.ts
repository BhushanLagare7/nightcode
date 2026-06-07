import type { Mode } from "@nightcode/database/enums";
import { createBashTool } from "./bash";
import { createEditFileTool } from "./edit-file";
import { createGlobTool } from "./glob";
import { createGrepTool } from "./grep";
import { createListDirectoryTool } from "./list-directory";
import { createReadFileTool } from "./read-file";
import { createWriteFileTool } from "./write-file";

export function createTools(cwd: string, mode: Mode) {
  const readOnlyTools = {
    readFile: createReadFileTool(cwd),
    listDirectory: createListDirectoryTool(cwd),
    grep: createGrepTool(cwd),
    glob: createGlobTool(cwd),
  };

  if (mode === "PLAN") {
    return readOnlyTools;
  }

  return {
    ...readOnlyTools,
    writeFile: createWriteFileTool(cwd),
    editFile: createEditFileTool(cwd),
    bash: createBashTool(cwd),
  };
}
