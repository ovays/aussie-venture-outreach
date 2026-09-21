import { runSenderAgent } from '../agents/sender'

async function main() {
  console.log("STARTING SENDER TEST")
  
  const result = await runSenderAgent('00000000-0000-0000-0000-000000000001')

  console.log("RESULT", result)
}

main().catch(console.error)
