import type { z } from "zod";
import type { saveReportInputSchema, savedReportSchema } from "./report";
type SaveReportInput = z.infer<typeof saveReportInputSchema>;
type SavedReport = z.infer<typeof savedReportSchema>;
export type { SaveReportInput, SavedReport };
