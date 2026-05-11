import { runSenderAgent } from '../agents/sender'

async function main() {
  console.log("STARTING SENDER TEST")
  
  const result = await runSenderAgent()

  console.log("RESULT", result)
}

main().catch(console.error)