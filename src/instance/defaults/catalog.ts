import type { ConnectorInfo } from "../../connectors/catalog.js";

/** Without an instance: no services of its own (src/instance/types.ts). Data only, the browser and the worker read this file too. */
export const connectors: readonly ConnectorInfo[] = [];
