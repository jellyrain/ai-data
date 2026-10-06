import type { z } from "zod";
import type {
  adminDatasetDetailSchema,
  currentPolicyStateSchema,
  policyVersionSchema,
  policyVersionSummarySchema,
} from "./catalog-management";
type AdminDatasetDetail = z.infer<typeof adminDatasetDetailSchema>;
type CurrentPolicyState = z.infer<typeof currentPolicyStateSchema>;
type PolicyVersion = z.infer<typeof policyVersionSchema>;
type PolicyVersionSummary = z.infer<typeof policyVersionSummarySchema>;
export type { AdminDatasetDetail, CurrentPolicyState, PolicyVersion, PolicyVersionSummary };
