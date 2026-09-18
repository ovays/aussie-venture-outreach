import { defineConfig } from "@trigger.dev/sdk/v3";
import { assertV2TriggerDeploymentTarget } from "./src/lib/v2-runtime-safety";

assertV2TriggerDeploymentTarget();
const project = process.env.TRIGGER_V2_PROJECT_REF!.trim();

export default defineConfig({
  project,
  dirs: ["./trigger"],
  runtime: "node-24",
  maxDuration: 3600,
});
