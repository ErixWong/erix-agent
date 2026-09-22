import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import {
  createFileNotesStore,
  createFileTranscriptStore,
  resolveNotesDir,
} from "../src/index.js";
import { safeRunId } from "../src/store/file.js";

function writeDiagnosticError(errorOutput, message) {
  if (errorOutput && typeof errorOutput.write === "function") {
    errorOutput.write(`${message}\n`);
    return;
  }
  console.error(message);
}

/**
 * Assemble the file-backed CLI ports shared by chat and REPL.
 *
 * @param {{
 *   dir:string,
 *   runId:string,
 *   cwd?:string,
 *   notesDir?:string,
 *   notesStore?:object,
 *   store?:object,
 *   errorOutput?:{write:Function},
 *   errorLog?:string
 * }} options
 * @returns {{store:object,notesStore:object,archiveDir:string,diagnostics:object}}
 */
export function createCliAssemblyRoot({
  dir,
  runId,
  notesDir,
  notesStore,
  store,
  cwd = process.cwd(),
  errorOutput = process.stderr,
  errorLog,
} = {}) {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new TypeError("assembly root dir must be a non-empty string");
  }
  if (typeof runId !== "string" || runId.length === 0) {
    throw new TypeError("assembly root runId must be a non-empty string");
  }
  const archiveDir = path.join(path.resolve(dir), "outputs", safeRunId(runId));
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const root = path.resolve(String(cwd));
  // 与 notes 工厂缺省语义对齐（resolveNotesDir：显式值 ?? ERIX_NOTES_DIR ?? ~/.erix/notes），
  // 避免装配根与工厂两套缺省。
  const resolvedNotesDir = path.resolve(resolveNotesDir(notesDir));
  const resolvedNotesStore = notesStore ?? createFileNotesStore({ dir: resolvedNotesDir });
  const diagnostics = {
    error(event) {
      const message =
        `Persistence error: ${event.operation} during ${event.phase} (runId=${String(event.runId)})`;
      writeDiagnosticError(errorOutput, message);
      if (errorLog) {
        try {
          appendFileSync(errorLog, `${JSON.stringify(event)}\n`, "utf8");
        } catch (error) {
          writeDiagnosticError(
            errorOutput,
            `Persistence error log write failed: ${error?.message ?? String(error)}`,
          );
        }
      }
    },
  };
  return {
    cwd: root,
    dir,
    archiveDir,
    store: store ?? createFileTranscriptStore({ dir }),
    notesDir: resolvedNotesDir,
    notesStore: resolvedNotesStore,
    diagnostics,
  };
}
