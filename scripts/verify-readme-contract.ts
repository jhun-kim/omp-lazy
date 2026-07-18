import { verifyReadmeContract } from "./readme-contract"

// no-excuse-ok: catch -- CLI boundary reports structural documentation failures.
try {
  const receipt = await verifyReadmeContract(process.cwd())
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
