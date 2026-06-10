import { invoke } from "@tauri-apps/api/core";

export interface ReportPayload {
  kind: "error" | "feature_request";
  body: string;
  fields: Record<string, unknown>;
  tail_lines: string[];
}

export const diagnosticsIpc = {
  /** Fetch up to `n` recent terminal log lines from the backend ring buffer. */
  getRecentLogLines: (n: number) =>
    invoke<string[]>("get_recent_log_lines", { n }),
  /** Submit the stub report. Backend writes JSON to AppData\diagnostics.
   *  Returns the path of the file so the modal can show "saved to …". */
  submitReport: (payload: ReportPayload) =>
    invoke<string>("submit_report", { payload }),
};
