import type { z } from "zod";
import type { queryEvidenceSchema, analysisStepSchema } from "./evidence";
type QueryEvidence = z.infer<typeof queryEvidenceSchema>;
type AnalysisStep = z.infer<typeof analysisStepSchema>;
export type { QueryEvidence, AnalysisStep };
