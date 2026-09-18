import type { z } from "zod";
import type {
  analysisRunStatusSchema,
  submitMessageSchema,
  clarificationSchema,
  clarificationAnswerSchema,
  runLeaseSchema,
  analysisRunSchema,
} from "./analysis-run";

type AnalysisRunStatus = z.infer<typeof analysisRunStatusSchema>;
type SubmitMessage = z.infer<typeof submitMessageSchema>;
type Clarification = z.infer<typeof clarificationSchema>;
type ClarificationAnswer = z.infer<typeof clarificationAnswerSchema>;
type RunLease = z.infer<typeof runLeaseSchema>;
type AnalysisRunState = z.infer<typeof analysisRunSchema>;

export type {
  AnalysisRunStatus,
  SubmitMessage,
  Clarification,
  ClarificationAnswer,
  RunLease,
  AnalysisRunState,
};
