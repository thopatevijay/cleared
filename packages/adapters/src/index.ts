// Vendor adapters (PayPal, OpenAI, BlobStore, PDF, email) behind interfaces from @cleared/core.
// Filled in by M0-04 onwards.
import { CORE_PACKAGE } from "@cleared/core";

export const ADAPTERS_PACKAGE = "@cleared/adapters";
export const dependsOn: readonly string[] = [CORE_PACKAGE];
