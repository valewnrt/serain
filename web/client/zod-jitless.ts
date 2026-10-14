import * as z from "zod/mini";

// Must run before any schema, hence a separate module that main.ts imports first: otherwise zod checks
// with `new Function` whether it may generate code, and the CSP (Trusted Types) reports that as a violation.
// From zod/mini, not zod: classic zod would add 450 KB; the setting applies to both.
z.config({ jitless: true });
