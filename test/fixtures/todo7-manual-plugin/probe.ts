import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions"
import { diagnoseCommandCollisions } from "../../../src/commands/register-workflow-commands"

const [linkedPath, collisionPath] = process.argv.slice(2)
if (linkedPath === undefined || collisionPath === undefined) process.exit(4)

const linked = await loadExtensions([linkedPath], process.cwd())
const inventory = linked.extensions.map((extension) => extension.commands)
const diagnostic = diagnoseCommandCollisions(inventory, [])
const product = linked.extensions[0]
console.log(
  JSON.stringify({
    errors: linked.errors,
    commands: product === undefined ? [] : [...product.commands.keys()],
    handlers:
      product === undefined
        ? {}
        : Object.fromEntries(
            [...product.handlers].map(([event, handlers]) => [event, handlers.length]),
          ),
    diagnostic,
  }),
)
if (linked.errors.length > 0 || diagnostic.status !== "PASS") process.exit(2)

const colliding = await loadExtensions([linkedPath, collisionPath], process.cwd())
const collisionDiagnostic = diagnoseCommandCollisions(
  colliding.extensions.map((extension) => extension.commands),
  [],
)
console.log(JSON.stringify({ collisionDiagnostic }))
if (collisionDiagnostic.status !== "FAIL") process.exit(3)
