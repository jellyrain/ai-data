import type { z } from "zod";
import type { managedDataAccessServiceSchema, databaseTargetSchema } from "./management-responses";
type ManagedDataAccessService = z.infer<typeof managedDataAccessServiceSchema>;
type DatabaseTarget = z.infer<typeof databaseTargetSchema>;
export type { ManagedDataAccessService, DatabaseTarget };
