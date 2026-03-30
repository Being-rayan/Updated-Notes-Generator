import "dotenv/config";

import { ensureAppReady } from "../app/services/bootstrap-service.js";
import { rebuildDefaultProfile } from "../app/services/style-profile-service.js";

await ensureAppReady();
const result = await rebuildDefaultProfile();
console.log(JSON.stringify(result, null, 2));
