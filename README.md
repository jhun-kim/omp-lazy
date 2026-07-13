# omp-lazy

`omp-lazy` is a source-only TypeScript extension for OMP 16.4.x. It is under active
development and is not published to a package registry.

The package loads through `package.json#omp.extensions` under Bun. OMP is an optional
peer and an exact development dependency only; the shipped runtime will not locate or
import another host installation.

## Development

Use Bun 1.3.14. `bun run check` runs the strict type, formatting, contract, and
integration gates through the isolated child-process wrapper.
