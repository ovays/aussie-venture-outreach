import {
  runFollowUpAgent
} from "../../../chunk-JAWUMJQK.mjs";
import "../../../chunk-QHUSIW44.mjs";
import {
  schedules_exports
} from "../../../chunk-YMG6YHR2.mjs";
import "../../../chunk-KOWVEGTZ.mjs";
import {
  __name,
  init_esm
} from "../../../chunk-ZETKKQG6.mjs";

// trigger/followup-job.ts
init_esm();
var followupJob = schedules_exports.task({
  id: "followup-job",
  cron: {
    pattern: "0 9 * * *",
    timezone: "Australia/Sydney"
  },
  maxDuration: 1800,
  run: /* @__PURE__ */ __name(async () => {
    console.log("Starting follow-up agent...");
    await runFollowUpAgent();
    console.log("Follow-up agent complete");
  }, "run")
});
export {
  followupJob
};
//# sourceMappingURL=followup-job.mjs.map
