import dotenv from "dotenv";
dotenv.config();

import { generateFU1 } from "../lib/ai/followups/generateFU1";
import { generateFU2 } from "../lib/ai/followups/generateFU2";
import { generateFU3 } from "../lib/ai/followups/generateFU3";

async function run() {
  const mockLead = {
    businessName: "Bondi Burger House",
    contactName: "John",
    category: "Restaurant",
    city: "Sydney",
    platform: "Instagram",
    website: "https://bondiburgerhouse.com.au",
  };

  console.log("\n====================");
  console.log("FU1");
  console.log("====================\n");

  const fu1 = await generateFU1(mockLead);

  console.log(fu1);

  console.log("\n====================");
  console.log("FU2");
  console.log("====================\n");

  const fu2 = await generateFU2(mockLead);

  console.log(fu2);

  console.log("\n====================");
  console.log("FU3");
  console.log("====================\n");

  const fu3 = await generateFU3(mockLead);

  console.log(fu3);

  console.log("\n====================");
  console.log("DONE");
  console.log("====================\n");
}

run().catch((err) => {
  console.error("Follow-up generation test failed:");
  console.error(err);
  process.exit(1);
});